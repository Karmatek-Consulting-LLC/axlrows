//! `run_query` fan-out: one tokio task per target, four `query://*` events,
//! and a cancellation registry backing `cancel_query`. Also `test_ucm`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::task::AbortHandle;
use uuid::Uuid;

use crate::db::Ucm;
use crate::{axl, creds, AppState};

pub const NO_PASSWORD_MSG: &str =
    "No password stored for this UCM — edit it and set a password.";
const DEFAULT_TIMEOUT_SECS: u64 = 60;
const TEST_TIMEOUT_SECS: u64 = 15;
const TEST_SQL: &str = "select first 1 pkid from processnode";

/// Abort handles for in-flight target tasks, keyed by runId.
#[derive(Default)]
pub struct RunRegistry(Mutex<HashMap<String, Vec<AbortHandle>>>);

impl RunRegistry {
    fn insert(&self, run_id: &str, handles: Vec<AbortHandle>) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id.to_string(), handles);
    }

    fn remove(&self, run_id: &str) -> Option<Vec<AbortHandle>> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(run_id)
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
struct Complete {
    run_id: String,
    ok_count: usize,
    err_count: usize,
    total_rows: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub elapsed_ms: u64,
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

async fn query_one_target(ucm: &Ucm, sql: &str, timeout_secs: u64) -> Result<axl::QueryResult, String> {
    let password = fetch_password(ucm.id.clone()).await?;
    let target = axl::AxlTarget {
        host: ucm.host.clone(),
        username: ucm.username.clone(),
        password,
        version: ucm.version.as_str().to_string(),
        verify_tls: ucm.verify_tls,
    };
    axl::execute_sql_query(&target, sql, timeout_secs)
        .await
        .map_err(|e| e.to_string())
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
        handle: tokio::task::JoinHandle<(bool, usize)>,
    }

    let mut pending: Vec<Pending> = Vec::with_capacity(targets.len());
    let mut aborts: Vec<AbortHandle> = Vec::with_capacity(targets.len());

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
                    (true, row_count)
                }
                Err(message) => {
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
                    (false, 0)
                }
            }
        });

        aborts.push(handle.abort_handle());
        pending.push(Pending {
            ucm_id,
            ucm_name,
            started,
            handle,
        });
    }

    state.registry.insert(&run_id, aborts);

    // Supervisor: waits for every target to settle, guarantees exactly one
    // terminal event per started target (emitting one itself if a task was
    // aborted mid-flight), then emits `query://complete` exactly once.
    let registry = state.registry.clone();
    let app_sup = app.clone();
    let run_id_sup = run_id.clone();
    tokio::spawn(async move {
        let mut ok_count = 0usize;
        let mut err_count = 0usize;
        let mut total_rows = 0usize;

        for target in pending {
            match target.handle.await {
                Ok((true, rows)) => {
                    ok_count += 1;
                    total_rows += rows;
                }
                Ok((false, _)) => err_count += 1,
                Err(join_err) => {
                    // Aborted (cancel_query) or panicked before the task
                    // could emit its own terminal event.
                    let message = if join_err.is_cancelled() {
                        "Query cancelled.".to_string()
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
        }

        registry.remove(&run_id_sup);
        let _ = app_sup.emit(
            "query://complete",
            Complete {
                run_id: run_id_sup,
                ok_count,
                err_count,
                total_rows,
            },
        );
    });

    Ok(run_id)
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    // Idempotent: cancelling an unknown or already-finished run is a no-op.
    if let Some(handles) = state.registry.remove(&run_id) {
        for handle in handles {
            handle.abort();
        }
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

    let target = axl::AxlTarget {
        host: ucm.host.clone(),
        username: ucm.username.clone(),
        password,
        version: ucm.version.as_str().to_string(),
        verify_tls: ucm.verify_tls,
    };

    let started = Instant::now();
    match axl::execute_sql_query(&target, TEST_SQL, TEST_TIMEOUT_SECS).await {
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
