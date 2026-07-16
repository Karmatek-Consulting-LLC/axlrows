//! AXLRows backend: Tauri builder, managed state, and the UCM/favorite
//! CRUD commands. Query fan-out lives in `query`, CSV export in `export`.

mod axl;
mod creds;
mod db;
mod error;
mod export;
mod query;

use std::sync::Arc;

use tauri::{Manager, State};
use uuid::Uuid;

use db::{Db, Favorite, Ucm, UcmInput};
use query::{RunRegistry, ThrottleStash};

pub struct AppState {
    pub db: Arc<Db>,
    pub registry: Arc<RunRegistry>,
    /// Latest ThrottleInfo per (runId, ucmId); lets `fetch_target_batched`
    /// report the true total in its progress events.
    pub throttles: Arc<ThrottleStash>,
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ---- UCM commands ----

#[tauri::command]
async fn list_ucms(state: State<'_, AppState>) -> Result<Vec<Ucm>, String> {
    let mut ucms = state.db.list_ucms().map_err(String::from)?;
    for ucm in &mut ucms {
        ucm.has_password = creds::has_password(&ucm.id);
    }
    Ok(ucms)
}

#[tauri::command]
async fn create_ucm(state: State<'_, AppState>, input: UcmInput) -> Result<Ucm, String> {
    let id = Uuid::new_v4().to_string();

    // Store the secret first: if the keychain is unavailable the command
    // fails outright and no half-configured UCM row is left behind.
    if let Some(password) = &input.password {
        creds::set_password(&id, password).map_err(String::from)?;
    }

    let ucm = Ucm {
        id,
        name: input.name,
        host: input.host,
        username: input.username,
        version: input.version,
        verify_tls: input.verify_tls,
        has_password: input.password.is_some(),
        created_at: now_rfc3339(),
    };
    if let Err(e) = state.db.insert_ucm(&ucm) {
        // Roll the keychain entry back so no orphaned secret lingers.
        let _ = creds::delete_password(&ucm.id);
        return Err(e.into());
    }
    Ok(ucm)
}

#[tauri::command]
async fn update_ucm(
    state: State<'_, AppState>,
    id: String,
    input: UcmInput,
) -> Result<Ucm, String> {
    // Ensures the UCM exists (and keeps its createdAt).
    let existing = state.db.get_ucm(&id).map_err(String::from)?;

    // None = leave the keychain entry untouched.
    if let Some(password) = &input.password {
        creds::set_password(&id, password).map_err(String::from)?;
    }
    state.db.update_ucm(&id, &input).map_err(String::from)?;

    Ok(Ucm {
        id: id.clone(),
        name: input.name,
        host: input.host,
        username: input.username,
        version: input.version,
        verify_tls: input.verify_tls,
        has_password: input.password.is_some() || creds::has_password(&id),
        created_at: existing.created_at,
    })
}

#[tauri::command]
async fn delete_ucm(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_ucm(&id).map_err(String::from)?;
    // Best effort — the UCM row is already gone; a keychain hiccup must not
    // resurrect it. An orphaned entry is deleted on the next create anyway.
    let _ = creds::delete_password(&id);
    Ok(())
}

// ---- favorite commands ----

#[tauri::command]
async fn list_favorites(state: State<'_, AppState>) -> Result<Vec<Favorite>, String> {
    state.db.list_favorites().map_err(String::from)
}

#[tauri::command]
async fn create_favorite(
    state: State<'_, AppState>,
    name: String,
    sql: String,
) -> Result<Favorite, String> {
    let now = now_rfc3339();
    let favorite = Favorite {
        id: Uuid::new_v4().to_string(),
        name: if name.trim().is_empty() {
            "Untitled query".to_string()
        } else {
            name
        },
        sql,
        created_at: now.clone(),
        updated_at: now,
    };
    state.db.insert_favorite(&favorite).map_err(String::from)?;
    Ok(favorite)
}

#[tauri::command]
async fn update_favorite(
    state: State<'_, AppState>,
    id: String,
    name: String,
    sql: String,
) -> Result<Favorite, String> {
    let updated_at = now_rfc3339();
    state
        .db
        .update_favorite(&id, &name, &sql, &updated_at)
        .map_err(String::from)?;
    state.db.get_favorite(&id).map_err(String::from)
}

#[tauri::command]
async fn delete_favorite(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_favorite(&id).map_err(String::from)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db = Db::open(&data_dir.join("axlrows.db"))?;
            app.manage(AppState {
                db: Arc::new(db),
                registry: Arc::new(RunRegistry::default()),
                throttles: Arc::new(ThrottleStash::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_ucms,
            create_ucm,
            update_ucm,
            delete_ucm,
            query::test_ucm,
            list_favorites,
            create_favorite,
            update_favorite,
            delete_favorite,
            query::run_query,
            query::cancel_query,
            query::fetch_target_batched,
            export::export_csv,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
