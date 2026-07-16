//! OS keychain wrapper. Passwords live ONLY here — never in SQLite, never
//! returned to the frontend.

use crate::error::{AppError, KEYCHAIN_UNAVAILABLE};
use keyring::Entry;

/// Keyring service name, per the IPC contract.
const SERVICE: &str = "io.karmatek.axlrows";

fn entry(ucm_id: &str) -> Result<Entry, AppError> {
    Entry::new(SERVICE, ucm_id).map_err(map_err)
}

fn map_err(e: keyring::Error) -> AppError {
    match e {
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => {
            AppError::Keychain(KEYCHAIN_UNAVAILABLE.to_string())
        }
        other => AppError::Keychain(format!("Keychain error: {other}")),
    }
}

pub fn set_password(ucm_id: &str, password: &str) -> Result<(), AppError> {
    entry(ucm_id)?.set_password(password).map_err(map_err)
}

/// Ok(None) = no password stored for this UCM. Err = keychain unavailable or
/// some other platform failure.
pub fn get_password(ucm_id: &str) -> Result<Option<String>, AppError> {
    match entry(ucm_id)?.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(map_err(e)),
    }
}

/// Best-effort delete; a missing entry is not an error.
pub fn delete_password(ucm_id: &str) -> Result<(), AppError> {
    match entry(ucm_id) {
        Ok(e) => match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_err(e)),
        },
        Err(e) => Err(e),
    }
}

/// Probe used to compute `hasPassword`. Any failure (including an
/// unavailable keychain) reads as "no password" — listing UCMs must not fail
/// just because the keychain is down.
pub fn has_password(ucm_id: &str) -> bool {
    matches!(get_password(ucm_id), Ok(Some(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Requires a live Secret Service (gnome-keyring); present on this box.
    #[test]
    fn keychain_roundtrip() {
        let id = format!("test-creds-{}", uuid::Uuid::new_v4());
        assert!(!has_password(&id));
        set_password(&id, "s3cret").unwrap();
        assert!(has_password(&id));
        assert_eq!(get_password(&id).unwrap(), Some("s3cret".to_string()));
        delete_password(&id).unwrap();
        assert!(!has_password(&id));
        assert_eq!(get_password(&id).unwrap(), None);
        // Deleting a missing entry stays a no-op.
        delete_password(&id).unwrap();
    }
}
