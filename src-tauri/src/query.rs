//! `run_query` fan-out: one tokio task per target, the `query://*` event
//! stream, a cancellation registry backing `cancel_query`, and the batched
//! re-fetch (`fetch_target_batched`) that recovers from UCM's 8 MB response
//! throttle. Also `test_ucm`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::task::AbortHandle;
use uuid::Uuid;

use crate::axl::{self, ThrottleInfo};
use crate::db::Ucm;
use crate::{creds, AppState};

pub const NO_PASSWORD_MSG: &str =
    "No password stored for this UCM — edit it and set a password.";
const CANCELLED_MSG: &str = "Query cancelled.";
const DEFAULT_TIMEOUT_SECS: u64 = 60;
const TEST_TIMEOUT_SECS: u64 = 15;
const TEST_SQL: &str = "select first 1 pkid from processnode";

/// Abort handles for in-flight tasks, keyed by runId. Each handle carries a
/// unique token so a single task (e.g. a batched re-fetch, which reuses the
/// original runId) can deregister itself when it settles without disturbing
/// other in-flight work under the same run.
#[derive(Default)]
pub struct RunRegistry {
    handles: Mutex<HashMap<String, Vec<(u64, AbortHandle)>>>,
    next_token: AtomicU64,
}

impl RunRegistry {
    fn add(&self, run_id: &str, handle: AbortHandle) -> u64 {
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        self.handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(run_id.to_string())
            .or_default()
            .push((token, handle));
        token
    }

    /// Remove every handle for a run (cancellation).
    fn remove_run(&self, run_id: &str) -> Vec<AbortHandle> {
        self.handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(run_id)
            .map(|handles| handles.into_iter().map(|(_, h)| h).collect())
            .unwrap_or_default()
    }

    /// Remove a single settled task's handle, dropping the run's entry when
    /// it was the last one.
    fn remove_handle(&self, run_id: &str, token: u64) {
        let mut map = self.handles.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(handles) = map.get_mut(run_id) {
            handles.retain(|(t, _)| *t != token);
            if handles.is_empty() {
                map.remove(run_id);
            }
        }
    }
}

/// The most recent `ThrottleInfo` per (runId, ucmId), recorded whenever a
/// `target-throttled` event fires. `fetch_target_batched` reads it back so
/// its progress events can report the true total from the first batch on.
#[derive(Default)]
pub struct ThrottleStash(Mutex<HashMap<(String, String), ThrottleInfo>>);

impl ThrottleStash {
    fn insert(&self, run_id: &str, ucm_id: &str, info: ThrottleInfo) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert((run_id.to_string(), ucm_id.to_string()), info);
    }

    fn take(&self, run_id: &str, ucm_id: &str) -> Option<ThrottleInfo> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&(run_id.to_string(), ucm_id.to_string()))
    }
}

// ---- event payloads (camelCase, per contract) ----

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetStarted {
    run_id: String,
    ucm_id: String,
    ucm_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetSuccess {
    run_id: String,
    ucm_id: String,
    ucm_name: String,
    columns: Vec<String>,
    rows: Vec<axl::Row>,
    elapsed_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetError {
    run_id: String,
    ucm_id: String,
    ucm_name: String,
    message: String,
    elapsed_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetThrottled {
    run_id: String,
    ucm_id: String,
    ucm_name: String,
    elapsed_ms: u64,
    throttle: ThrottleInfo,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetBatchProgress {
    run_id: String,
    ucm_id: String,
    ucm_name: String,
    /// 1-based index of the batch that just completed.
    batch_index: u64,
    batches: u64,
    fetched: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Complete {
    run_id: String,
    ok_count: usize,
    err_count: usize,
    throttled_count: usize,
    total_rows: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub elapsed_ms: u64,
}

/// How a target task settled (its terminal event was already emitted).
enum Outcome {
    Success(usize),
    Error,
    Throttled,
}

/// A target failure that still needs its terminal event emitted.
enum TargetFail {
    Throttled(ThrottleInfo),
    Message(String),
}

/// Fetch the keychain password without blocking the async runtime.
async fn fetch_password(ucm_id: String) -> Result<String, String> {
    let result = tokio::task::spawn_blocking(move || creds::get_password(&ucm_id))
        .await
        .map_err(|e| format!("Internal error: {e}"))?;
    match result {
        Ok(Some(pw)) => Ok(pw),
        Ok(None) => Err(NO_PASSWORD_MSG.to_string()),
        Err(e) => Err(e.into()),
    }
}

fn axl_target(ucm: &Ucm, password: String) -> axl::AxlTarget {
    axl::AxlTarget {
        host: ucm.host.clone(),
        username: ucm.username.clone(),
        password,
        version: ucm.version.as_str().to_string(),
        verify_tls: ucm.verify_tls,
    }
}

async fn query_one_target(
    ucm: &Ucm,
    sql: &str,
    timeout_secs: u64,
) -> Result<axl::QueryResult, TargetFail> {
    let password = fetch_password(ucm.id.clone())
        .await
        .map_err(TargetFail::Message)?;
    axl::execute_sql_query(&axl_target(ucm, password), sql, timeout_secs)
        .await
        .map_err(|e| match e {
            axl::AxlError::Throttled(info) => TargetFail::Throttled(info),
            other => TargetFail::Message(other.to_string()),
        })
}

/// The throttle fault only proves the response was too big — it says nothing
/// about whether THIS statement can be safely rewritten for paging. Check,
/// and downgrade `can_paginate` with the refusal reason if not, so the UI
/// explains instead of offering a button that cannot work.
fn finalize_throttle_info(sql: &str, mut info: ThrottleInfo) -> ThrottleInfo {
    if info.can_paginate {
        if let Err(reason) = axl::paginate_sql(sql, 0, info.batch_size) {
            info.can_paginate = false;
            info.reason = Some(reason);
        }
    }
    info
}

#[tauri::command]
pub async fn run_query(
    app: AppHandle,
    state: State<'_, AppState>,
    sql: String,
    target_ids: Vec<String>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let timeout = timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).max(1);
    let run_id = Uuid::new_v4().to_string();

    // Resolve every target up front so an unknown id rejects the whole call
    // before any events fire.
    let mut targets: Vec<Ucm> = Vec::with_capacity(target_ids.len());
    for id in &target_ids {
        targets.push(state.db.get_ucm(id).map_err(String::from)?);
    }

    struct Pending {
        ucm_id: String,
        ucm_name: String,
        started: Instant,
        token: u64,
        handle: tokio::task::JoinHandle<Outcome>,
    }

    let mut pending: Vec<Pending> = Vec::with_capacity(targets.len());

    for ucm in targets {
        // Emit `started` synchronously so every target gets exactly one
        // started event even if it is cancelled before its task first polls.
        let _ = app.emit(
            "query://target-started",
            TargetStarted {
                run_id: run_id.clone(),
                ucm_id: ucm.id.clone(),
                ucm_name: ucm.name.clone(),
            },
        );

        let app_task = app.clone();
        let run_id_task = run_id.clone();
        let sql_task = sql.clone();
        let throttles = state.throttles.clone();
        let ucm_id = ucm.id.clone();
        let ucm_name = ucm.name.clone();
        let started = Instant::now();

        let handle = tokio::spawn(async move {
            match query_one_target(&ucm, &sql_task, timeout).await {
                Ok(result) => {
                    let row_count = result.rows.len();
                    let _ = app_task.emit(
                        "query://target-success",
                        TargetSuccess {
                            run_id: run_id_task,
                            ucm_id: ucm.id.clone(),
                            ucm_name: ucm.name.clone(),
                            columns: result.columns,
                            rows: result.rows,
                            elapsed_ms: started.elapsed().as_millis() as u64,
                        },
                    );
                    Outcome::Success(row_count)
                }
                Err(TargetFail::Throttled(info)) => {
                    let info = finalize_throttle_info(&sql_task, info);
                    throttles.insert(&run_id_task, &ucm.id, info.clone());
                    let _ = app_task.emit(
                        "query://target-throttled",
                        TargetThrottled {
                            run_id: run_id_task,
                            ucm_id: ucm.id.clone(),
                            ucm_name: ucm.name.clone(),
                            elapsed_ms: started.elapsed().as_millis() as u64,
                            throttle: info,
                        },
                    );
                    Outcome::Throttled
                }
                Err(TargetFail::Message(message)) => {
                    let _ = app_task.emit(
                        "query://target-error",
                        TargetError {
                            run_id: run_id_task,
                            ucm_id: ucm.id.clone(),
                            ucm_name: ucm.name.clone(),
                            message,
                            elapsed_ms: started.elapsed().as_millis() as u64,
                        },
                    );
                    Outcome::Error
                }
            }
        });

        let token = state.registry.add(&run_id, handle.abort_handle());
        pending.push(Pending {
            ucm_id,
            ucm_name,
            started,
            token,
            handle,
        });
    }

    // Supervisor: waits for every target to settle, guarantees exactly one
    // terminal event per started target (emitting one itself if a task was
    // aborted mid-flight), then emits `query://complete` exactly once.
    let registry = state.registry.clone();
    let app_sup = app.clone();
    let run_id_sup = run_id.clone();
    tokio::spawn(async move {
        let mut ok_count = 0usize;
        let mut err_count = 0usize;
        let mut throttled_count = 0usize;
        let mut total_rows = 0usize;

        for target in pending {
            match target.handle.await {
                Ok(Outcome::Success(rows)) => {
                    ok_count += 1;
                    total_rows += rows;
                }
                Ok(Outcome::Error) => err_count += 1,
                Ok(Outcome::Throttled) => throttled_count += 1,
                Err(join_err) => {
                    // Aborted (cancel_query) or panicked before the task
                    // could emit its own terminal event.
                    let message = if join_err.is_cancelled() {
                        CANCELLED_MSG.to_string()
                    } else {
                        format!("Internal error: {join_err}")
                    };
                    let _ = app_sup.emit(
                        "query://target-error",
                        TargetError {
                            run_id: run_id_sup.clone(),
                            ucm_id: target.ucm_id,
                            ucm_name: target.ucm_name,
                            message,
                            elapsed_ms: target.started.elapsed().as_millis() as u64,
                        },
                    );
                    err_count += 1;
                }
            }
            registry.remove_handle(&run_id_sup, target.token);
        }

        let _ = app_sup.emit(
            "query://complete",
            Complete {
                run_id: run_id_sup,
                ok_count,
                err_count,
                throttled_count,
                total_rows,
            },
        );
    });

    Ok(run_id)
}

/// Re-run ONE throttled target inside an existing run, fetching in Informix
/// SKIP/FIRST batches. Emits `target-started` first, one
/// `target-batch-progress` per completed batch, and exactly one terminal
/// event (`target-success` with the full merged row set, `target-error`, or
/// `target-throttled` if even the smallest batch still throttles) — but
/// never `query://complete`; the run already completed. Cancellable via the
/// existing `cancel_query(runId)`.
#[tauri::command]
pub async fn fetch_target_batched(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    ucm_id: String,
    sql: String,
    batch_size: u64,
    timeout_secs: Option<u64>,
) -> Result<(), String> {
    let timeout = timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).max(1);
    let batch_size = batch_size.max(1);
    let ucm = state.db.get_ucm(&ucm_id).map_err(String::from)?;

    // Refuse before any event fires if the SQL cannot be rewritten — the
    // target has not been (re)started yet, so the invoke itself rejects.
    axl::paginate_sql(&sql, 0, batch_size)?;

    // The throttle fault that led here reported the real total; use it so
    // progress events are meaningful from the first batch.
    let total_hint = state
        .throttles
        .take(&run_id, &ucm.id)
        .map(|info| info.total_rows)
        .filter(|t| *t > 0);

    // The target's chip returns to a running state.
    let _ = app.emit(
        "query://target-started",
        TargetStarted {
            run_id: run_id.clone(),
            ucm_id: ucm.id.clone(),
            ucm_name: ucm.name.clone(),
        },
    );

    let app_task = app.clone();
    let run_id_task = run_id.clone();
    let throttles = state.throttles.clone();
    let started = Instant::now();
    let ucm_task = ucm.clone();

    let worker = tokio::spawn(async move {
        let ucm = ucm_task;
        let password = match fetch_password(ucm.id.clone()).await {
            Ok(pw) => pw,
            Err(message) => {
                let _ = app_task.emit(
                    "query://target-error",
                    TargetError {
                        run_id: run_id_task.clone(),
                        ucm_id: ucm.id.clone(),
                        ucm_name: ucm.name.clone(),
                        message,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    },
                );
                return;
            }
        };
        let target = axl_target(&ucm, password);

        let on_batch = |p: axl::BatchProgress| {
            let _ = app_task.emit(
                "query://target-batch-progress",
                TargetBatchProgress {
                    run_id: run_id_task.clone(),
                    ucm_id: ucm.id.clone(),
                    ucm_name: ucm.name.clone(),
                    batch_index: p.batch_index,
                    batches: p.batches,
                    fetched: p.fetched,
                    total: p.total,
                },
            );
        };

        match axl::fetch_batched(&target, &sql, batch_size, total_hint, timeout, on_batch).await {
            Ok(result) => {
                let _ = app_task.emit(
                    "query://target-success",
                    TargetSuccess {
                        run_id: run_id_task.clone(),
                        ucm_id: ucm.id.clone(),
                        ucm_name: ucm.name.clone(),
                        columns: result.columns,
                        rows: result.rows,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    },
                );
            }
            Err(axl::AxlError::Throttled(info)) => {
                // Even the smallest batch still overflowed the 8 MB cap.
                let info = finalize_throttle_info(&sql, info);
                throttles.insert(&run_id_task, &ucm.id, info.clone());
                let _ = app_task.emit(
                    "query://target-throttled",
                    TargetThrottled {
                        run_id: run_id_task.clone(),
                        ucm_id: ucm.id.clone(),
                        ucm_name: ucm.name.clone(),
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        throttle: info,
                    },
                );
            }
            Err(e) => {
                let _ = app_task.emit(
                    "query://target-error",
                    TargetError {
                        run_id: run_id_task.clone(),
                        ucm_id: ucm.id.clone(),
                        ucm_name: ucm.name.clone(),
                        message: e.to_string(),
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    },
                );
            }
        }
    });

    // Supervisor: if the worker is aborted (cancel_query) or panics before
    // emitting its terminal event, emit one here — the exactly-one-terminal-
    // event rule holds for batched re-fetches too.
    let token = state.registry.add(&run_id, worker.abort_handle());
    let registry = state.registry.clone();
    let app_sup = app.clone();
    let ucm_id_sup = ucm.id.clone();
    let ucm_name_sup = ucm.name.clone();
    tokio::spawn(async move {
        if let Err(join_err) = worker.await {
            let message = if join_err.is_cancelled() {
                CANCELLED_MSG.to_string()
            } else {
                format!("Internal error: {join_err}")
            };
            let _ = app_sup.emit(
                "query://target-error",
                TargetError {
                    run_id: run_id.clone(),
                    ucm_id: ucm_id_sup,
                    ucm_name: ucm_name_sup,
                    message,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                },
            );
        }
        registry.remove_handle(&run_id, token);
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    // Idempotent: cancelling an unknown or already-finished run is a no-op.
    for handle in state.registry.remove_run(&run_id) {
        handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn test_ucm(state: State<'_, AppState>, id: String) -> Result<TestResult, String> {
    let ucm = state.db.get_ucm(&id).map_err(String::from)?;

    // Keychain problems are command failures per the contract, except a
    // simply-missing password, which is a diagnosable "not ok" result.
    let password = match fetch_password(ucm.id.clone()).await {
        Ok(pw) => pw,
        Err(msg) if msg == NO_PASSWORD_MSG => {
            return Ok(TestResult {
                ok: false,
                message: msg,
                elapsed_ms: 0,
            })
        }
        Err(msg) => return Err(msg),
    };

    let started = Instant::now();
    match axl::execute_sql_query(&axl_target(&ucm, password), TEST_SQL, TEST_TIMEOUT_SECS).await {
        Ok(_) => Ok(TestResult {
            ok: true,
            message: format!("Connected — AXL on {} is responding.", ucm.host),
            elapsed_ms: started.elapsed().as_millis() as u64,
        }),
        Err(e) => Ok(TestResult {
            ok: false,
            message: e.to_string(),
            elapsed_ms: started.elapsed().as_millis() as u64,
        }),
    }
}
