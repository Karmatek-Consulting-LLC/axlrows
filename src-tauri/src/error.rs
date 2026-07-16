//! Central error type. All Tauri commands return `Result<T, String>`; this
//! module provides the conversions so command bodies stay terse.

use thiserror::Error;

/// Exact message required by the IPC contract when no OS keychain is available.
pub const KEYCHAIN_UNAVAILABLE: &str =
    "No OS keychain available — install gnome-keyring or run inside a desktop session.";

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Db(String),
    #[error("{0}")]
    Keychain(String),
    #[error("{0}")]
    NotFound(String),
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db(format!("Database error: {e}"))
    }
}

impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}
