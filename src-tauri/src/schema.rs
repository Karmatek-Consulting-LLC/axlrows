//! Live schema introspection for SQL autocomplete: `fetch_schema` reads the
//! Informix system catalog off a UCM over AXL (the same tables the data
//! dictionary documents), caches the result in SQLite, and `get_schema`
//! serves the union of every cached server back to the editor.

use std::collections::BTreeMap;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use crate::query::{axl_target, fetch_password};
use crate::{axl, AppState};

/// User tables start at tabid 100 in Informix; below that is the catalog
/// itself. Ordering by colno keeps each table's columns in DDL order, which
/// is the order engineers know them in.
const SCHEMA_SQL: &str = "select t.tabname, c.colname from systables t, syscolumns c \
     where c.tabid = t.tabid and t.tabid > 99 and t.tabtype = 'T' \
     order by t.tabname, c.colno";

const SCHEMA_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    /// table name -> column names, DDL order.
    pub tables: BTreeMap<String, Vec<String>>,
    pub fetched_at: String,
    pub table_count: usize,
    pub column_count: usize,
    pub elapsed_ms: u64,
}

fn to_schema_map(rows: &[axl::Row]) -> BTreeMap<String, Vec<String>> {
    let mut tables: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in rows {
        let (Some(tab), Some(col)) = (row.get("tabname"), row.get("colname")) else {
            continue;
        };
        let (tab, col) = (tab.trim(), col.trim());
        if tab.is_empty() || col.is_empty() {
            continue;
        }
        tables.entry(tab.to_string()).or_default().push(col.to_string());
    }
    tables
}

fn counts(tables: &BTreeMap<String, Vec<String>>) -> (usize, usize) {
    (tables.len(), tables.values().map(Vec::len).sum())
}

/// Introspect one UCM's schema and cache it. The catalog query can exceed
/// UCM's 8 MB response cap on schema-heavy versions, so a throttle fault
/// falls back to the same SKIP/FIRST batched fetch queries use.
#[tauri::command]
pub async fn fetch_schema(state: State<'_, AppState>, id: String) -> Result<SchemaInfo, String> {
    let ucm = state.db.get_ucm(&id).map_err(String::from)?;
    let password = fetch_password(ucm.id.clone()).await?;
    let target = axl_target(&ucm, password);

    let started = Instant::now();
    let result = match axl::execute_sql_query(&target, SCHEMA_SQL, SCHEMA_TIMEOUT_SECS).await {
        Ok(r) => r,
        Err(axl::AxlError::Throttled(info)) => axl::fetch_batched(
            &target,
            SCHEMA_SQL,
            info.batch_size,
            Some(info.total_rows),
            SCHEMA_TIMEOUT_SECS,
            |_| {},
        )
        .await
        .map_err(|e| e.to_string())?,
        Err(e) => return Err(e.to_string()),
    };

    let tables = to_schema_map(&result.rows);
    if tables.is_empty() {
        return Err("The schema query returned no tables — is this a UCM publisher?".into());
    }
    let fetched_at = chrono::Utc::now().to_rfc3339();
    let data = serde_json::to_string(&tables).map_err(|e| e.to_string())?;
    state
        .db
        .upsert_schema(&ucm.id, &fetched_at, &data)
        .map_err(String::from)?;

    let (table_count, column_count) = counts(&tables);
    Ok(SchemaInfo {
        tables,
        fetched_at,
        table_count,
        column_count,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// The union of every cached server schema (UCM versions differ slightly;
/// the editor should suggest a column if ANY configured server has it).
/// None until at least one schema has been fetched.
#[tauri::command]
pub async fn get_schema(state: State<'_, AppState>) -> Result<Option<SchemaInfo>, String> {
    let stored = state.db.list_schemas().map_err(String::from)?;
    if stored.is_empty() {
        return Ok(None);
    }

    let mut tables: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut fetched_at = String::new();
    for s in stored {
        let one: BTreeMap<String, Vec<String>> =
            serde_json::from_str(&s.data).map_err(|e| e.to_string())?;
        for (tab, cols) in one {
            let entry = tables.entry(tab).or_default();
            for col in cols {
                if !entry.contains(&col) {
                    entry.push(col);
                }
            }
        }
        if s.fetched_at > fetched_at {
            fetched_at = s.fetched_at;
        }
    }

    let (table_count, column_count) = counts(&tables);
    Ok(Some(SchemaInfo {
        tables,
        fetched_at,
        table_count,
        column_count,
        elapsed_ms: 0,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(tab: &str, col: &str) -> axl::Row {
        let mut r = axl::Row::new();
        r.insert("tabname".into(), tab.into());
        r.insert("colname".into(), col.into());
        r
    }

    #[test]
    fn schema_map_groups_columns_in_row_order() {
        let rows = vec![
            row("device", "pkid"),
            row("device", "name"),
            row("device", "description"),
            row("numplan", "dnorpattern"),
        ];
        let map = to_schema_map(&rows);
        assert_eq!(map.len(), 2);
        assert_eq!(map["device"], vec!["pkid", "name", "description"]);
        assert_eq!(map["numplan"], vec!["dnorpattern"]);
        assert_eq!(counts(&map), (2, 4));
    }

    #[test]
    fn schema_map_skips_malformed_rows() {
        let mut missing_col = axl::Row::new();
        missing_col.insert("tabname".into(), "device".into());
        let rows = vec![missing_col, row("", "x"), row("device", "name")];
        let map = to_schema_map(&rows);
        assert_eq!(map.len(), 1);
        assert_eq!(map["device"], vec!["name"]);
    }
}
