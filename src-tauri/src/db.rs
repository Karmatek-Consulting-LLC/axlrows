//! SQLite store for `ucms` and `favorites`. Passwords are NEVER stored here.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// The AXL schema versions the app can speak. Serialized exactly as the
/// dotted string (e.g. "12.5") on both the wire and in SQLite.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AxlVersion {
    #[serde(rename = "7.0")]
    V7_0,
    #[serde(rename = "7.1")]
    V7_1,
    #[serde(rename = "8.0")]
    V8_0,
    #[serde(rename = "8.5")]
    V8_5,
    #[serde(rename = "9.0")]
    V9_0,
    #[serde(rename = "9.1")]
    V9_1,
    #[serde(rename = "10.0")]
    V10_0,
    #[serde(rename = "10.5")]
    V10_5,
    #[serde(rename = "11.0")]
    V11_0,
    #[serde(rename = "11.5")]
    V11_5,
    #[serde(rename = "12.0")]
    V12_0,
    #[serde(rename = "12.5")]
    V12_5,
    #[serde(rename = "14.0")]
    V14_0,
    #[serde(rename = "15.0")]
    V15_0,
}

impl AxlVersion {
    pub fn as_str(&self) -> &'static str {
        match self {
            AxlVersion::V7_0 => "7.0",
            AxlVersion::V7_1 => "7.1",
            AxlVersion::V8_0 => "8.0",
            AxlVersion::V8_5 => "8.5",
            AxlVersion::V9_0 => "9.0",
            AxlVersion::V9_1 => "9.1",
            AxlVersion::V10_0 => "10.0",
            AxlVersion::V10_5 => "10.5",
            AxlVersion::V11_0 => "11.0",
            AxlVersion::V11_5 => "11.5",
            AxlVersion::V12_0 => "12.0",
            AxlVersion::V12_5 => "12.5",
            AxlVersion::V14_0 => "14.0",
            AxlVersion::V15_0 => "15.0",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "7.0" => AxlVersion::V7_0,
            "7.1" => AxlVersion::V7_1,
            "8.0" => AxlVersion::V8_0,
            "8.5" => AxlVersion::V8_5,
            "9.0" => AxlVersion::V9_0,
            "9.1" => AxlVersion::V9_1,
            "10.0" => AxlVersion::V10_0,
            "10.5" => AxlVersion::V10_5,
            "11.0" => AxlVersion::V11_0,
            "11.5" => AxlVersion::V11_5,
            "12.0" => AxlVersion::V12_0,
            "12.5" => AxlVersion::V12_5,
            "14.0" => AxlVersion::V14_0,
            "15.0" => AxlVersion::V15_0,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ucm {
    pub id: String,
    pub name: String,
    pub host: String,
    pub username: String,
    pub version: AxlVersion,
    pub verify_tls: bool,
    /// Computed by probing the keychain; never persisted.
    pub has_password: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UcmInput {
    pub name: String,
    pub host: String,
    pub username: String,
    /// None on update = leave the keychain entry untouched.
    #[serde(default)]
    pub password: Option<String>,
    pub version: AxlVersion,
    pub verify_tls: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub created_at: String,
    pub updated_at: String,
}

pub struct Db(Mutex<Connection>);

impl Db {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let conn = Connection::open(path)?;
        migrate(&conn)?;
        Ok(Db(Mutex::new(conn)))
    }

    /// In-memory database, for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory()?;
        migrate(&conn)?;
        Ok(Db(Mutex::new(conn)))
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A poisoned mutex means a previous panic mid-statement; the
        // connection itself is still usable for our simple statements.
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ---- ucms ----

    pub fn list_ucms(&self) -> Result<Vec<Ucm>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, host, username, version, verify_tls, created_at
             FROM ucms ORDER BY created_at, name",
        )?;
        let rows = stmt.query_map([], row_to_ucm)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r??);
        }
        Ok(out)
    }

    pub fn get_ucm(&self, id: &str) -> Result<Ucm, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, host, username, version, verify_tls, created_at
             FROM ucms WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_ucm)?;
        match rows.next() {
            Some(r) => Ok(r??),
            None => Err(AppError::NotFound(format!("UCM not found: {id}"))),
        }
    }

    pub fn insert_ucm(&self, ucm: &Ucm) -> Result<(), AppError> {
        self.conn().execute(
            "INSERT INTO ucms (id, name, host, username, version, verify_tls, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                ucm.id,
                ucm.name,
                ucm.host,
                ucm.username,
                ucm.version.as_str(),
                ucm.verify_tls as i64,
                ucm.created_at
            ],
        )?;
        Ok(())
    }

    pub fn update_ucm(&self, id: &str, input: &UcmInput) -> Result<(), AppError> {
        let n = self.conn().execute(
            "UPDATE ucms SET name = ?2, host = ?3, username = ?4, version = ?5, verify_tls = ?6
             WHERE id = ?1",
            params![
                id,
                input.name,
                input.host,
                input.username,
                input.version.as_str(),
                input.verify_tls as i64
            ],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("UCM not found: {id}")));
        }
        Ok(())
    }

    pub fn delete_ucm(&self, id: &str) -> Result<(), AppError> {
        let n = self
            .conn()
            .execute("DELETE FROM ucms WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(AppError::NotFound(format!("UCM not found: {id}")));
        }
        Ok(())
    }

    // ---- favorites ----

    pub fn list_favorites(&self) -> Result<Vec<Favorite>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, sql, created_at, updated_at
             FROM favorites ORDER BY created_at, name",
        )?;
        let rows = stmt.query_map([], row_to_favorite)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_favorite(&self, id: &str) -> Result<Favorite, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, sql, created_at, updated_at FROM favorites WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_favorite)?;
        match rows.next() {
            Some(r) => Ok(r?),
            None => Err(AppError::NotFound(format!("Favorite not found: {id}"))),
        }
    }

    pub fn insert_favorite(&self, fav: &Favorite) -> Result<(), AppError> {
        self.conn().execute(
            "INSERT INTO favorites (id, name, sql, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![fav.id, fav.name, fav.sql, fav.created_at, fav.updated_at],
        )?;
        Ok(())
    }

    pub fn update_favorite(
        &self,
        id: &str,
        name: &str,
        sql: &str,
        updated_at: &str,
    ) -> Result<(), AppError> {
        let n = self.conn().execute(
            "UPDATE favorites SET name = ?2, sql = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, name, sql, updated_at],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("Favorite not found: {id}")));
        }
        Ok(())
    }

    pub fn delete_favorite(&self, id: &str) -> Result<(), AppError> {
        let n = self
            .conn()
            .execute("DELETE FROM favorites WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(AppError::NotFound(format!("Favorite not found: {id}")));
        }
        Ok(())
    }
}

fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS ucms (
                 id         TEXT PRIMARY KEY,
                 name       TEXT NOT NULL,
                 host       TEXT NOT NULL,
                 username   TEXT NOT NULL,
                 version    TEXT NOT NULL,
                 verify_tls INTEGER NOT NULL DEFAULT 0,
                 created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS favorites (
                 id         TEXT PRIMARY KEY,
                 name       TEXT NOT NULL,
                 sql        TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             PRAGMA user_version = 1;
             COMMIT;",
        )?;
    }
    Ok(())
}

type SqlRow<'a, 'b> = &'a rusqlite::Row<'b>;

fn row_to_ucm(row: SqlRow) -> rusqlite::Result<Result<Ucm, AppError>> {
    let version_str: String = row.get(4)?;
    let version = match AxlVersion::parse(&version_str) {
        Some(v) => v,
        None => {
            return Ok(Err(AppError::Db(format!(
                "Unknown AXL version '{version_str}' stored in database."
            ))))
        }
    };
    Ok(Ok(Ucm {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        username: row.get(3)?,
        version,
        verify_tls: row.get::<_, i64>(5)? != 0,
        has_password: false, // computed by the caller via the keychain probe
        created_at: row.get(6)?,
    }))
}

fn row_to_favorite(row: SqlRow) -> rusqlite::Result<Favorite> {
    Ok(Favorite {
        id: row.get(0)?,
        name: row.get(1)?,
        sql: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ucm_crud_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let ucm = Ucm {
            id: "abc".into(),
            name: "Lab".into(),
            host: "cucm.example.com".into(),
            username: "axluser".into(),
            version: AxlVersion::V12_5,
            verify_tls: false,
            has_password: false,
            created_at: "2026-01-01T00:00:00+00:00".into(),
        };
        db.insert_ucm(&ucm).unwrap();
        let got = db.get_ucm("abc").unwrap();
        assert_eq!(got.host, "cucm.example.com");
        assert_eq!(got.version, AxlVersion::V12_5);
        assert!(!got.verify_tls);

        let input = UcmInput {
            name: "Lab2".into(),
            host: "10.0.0.1".into(),
            username: "axluser".into(),
            password: None,
            version: AxlVersion::V15_0,
            verify_tls: true,
        };
        db.update_ucm("abc", &input).unwrap();
        let got = db.get_ucm("abc").unwrap();
        assert_eq!(got.name, "Lab2");
        assert_eq!(got.version, AxlVersion::V15_0);
        assert!(got.verify_tls);

        db.delete_ucm("abc").unwrap();
        assert!(db.get_ucm("abc").is_err());
        assert!(db.list_ucms().unwrap().is_empty());
    }

    #[test]
    fn favorite_crud_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let fav = Favorite {
            id: "f1".into(),
            name: "All phones".into(),
            sql: "select name from device".into(),
            created_at: "2026-01-01T00:00:00+00:00".into(),
            updated_at: "2026-01-01T00:00:00+00:00".into(),
        };
        db.insert_favorite(&fav).unwrap();
        db.update_favorite("f1", "Phones", "select * from device", "2026-01-02T00:00:00+00:00")
            .unwrap();
        let got = db.get_favorite("f1").unwrap();
        assert_eq!(got.name, "Phones");
        assert_eq!(got.updated_at, "2026-01-02T00:00:00+00:00");
        db.delete_favorite("f1").unwrap();
        assert!(db.list_favorites().unwrap().is_empty());
    }

    #[test]
    fn axl_version_serde_uses_dotted_strings() {
        let v: AxlVersion = serde_json::from_str("\"12.5\"").unwrap();
        assert_eq!(v, AxlVersion::V12_5);
        assert_eq!(serde_json::to_string(&AxlVersion::V14_0).unwrap(), "\"14.0\"");
        assert!(serde_json::from_str::<AxlVersion>("\"13.0\"").is_err());
    }
}
