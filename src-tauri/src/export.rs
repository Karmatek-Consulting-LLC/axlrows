//! CSV export via the OS save dialog.

use std::collections::HashMap;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Opens a save dialog and writes the given columns/rows as CSV.
/// Returns the saved path, or None if the user cancelled.
#[tauri::command]
pub async fn export_csv(
    app: AppHandle,
    columns: Vec<String>,
    rows: Vec<HashMap<String, String>>,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter("CSV", &["csv"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let Some(file_path) = rx.await.map_err(|e| format!("Save dialog failed: {e}"))? else {
        return Ok(None); // user cancelled
    };
    let path = file_path
        .into_path()
        .map_err(|e| format!("Invalid save path: {e}"))?;

    let path_for_write = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut writer = csv::Writer::from_path(&path_for_write)
            .map_err(|e| format!("Could not create the CSV file: {e}"))?;
        writer
            .write_record(&columns)
            .map_err(|e| format!("Could not write the CSV header: {e}"))?;
        for row in &rows {
            let record = columns
                .iter()
                .map(|c| row.get(c).map(String::as_str).unwrap_or(""));
            writer
                .write_record(record)
                .map_err(|e| format!("Could not write a CSV row: {e}"))?;
        }
        writer
            .flush()
            .map_err(|e| format!("Could not finish writing the CSV file: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Internal error: {e}"))??;

    Ok(Some(path.to_string_lossy().into_owned()))
}
