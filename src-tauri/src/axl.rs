//! The AXL SOAP client: envelope construction, HTTP transport, XML response
//! parsing, and error mapping. No WSDL — the envelope is built directly and
//! responses are parsed by matching element LOCAL NAMES only, because
//! namespace prefixes vary across UCM versions.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;

use quick_xml::events::Event;
use quick_xml::Reader;
use regex::Regex;
use serde::Serialize;
use thiserror::Error;

/// A result row: flat string map. Every value is stringified; null -> "".
pub type Row = HashMap<String, String>;

#[derive(Debug, Clone, PartialEq)]
pub struct QueryResult {
    /// Column order = child element order of the FIRST `<row>`, plus any
    /// extra keys found in later rows appended at the end.
    pub columns: Vec<String>,
    pub rows: Vec<Row>,
}

#[derive(Debug, Error, PartialEq)]
pub enum AxlError {
    #[error("Could not connect to {0} — check the address and that AXL is reachable on port 8443.")]
    Connect(String),
    #[error("Unauthorized — check the AXL username and password.")]
    Unauthorized,
    #[error("Forbidden — the account lacks the 'Standard AXL API Access' role.")]
    Forbidden,
    /// SOAP Fault: the faultstring, verbatim.
    #[error("{0}")]
    Fault(String),
    #[error("Query timed out after {0}s.")]
    Timeout(u64),
    #[error("AXL returned HTTP {0} {1}.")]
    Http(u16, String),
    #[error("Could not parse the AXL response: {0}")]
    Parse(String),
    /// UCM's request throttle (Cisco documents 503 as the write-throttle
    /// response; reads can see it under load).
    #[error("UCM is throttling requests right now (HTTP 503) — wait a moment and retry.")]
    ServiceUnavailable,
    /// UCM's 8 MB response cap tripped ("Query request too large. ...").
    #[error("Query request too large — UCM caps executeSQLQuery responses at 8 MB.")]
    Throttled(ThrottleInfo),
}

/// Everything the frontend needs to explain a throttled target and offer a
/// batched re-fetch. Serialized camelCase into the `target-throttled` event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleInfo {
    /// "Total rows matched: N"
    pub total_rows: u64,
    /// "Suggested row fetch: less than M" — M itself (an exclusive bound).
    pub suggested_fetch: u64,
    /// What AXLRows will actually use: `suggested_fetch - 1`, clamped to >= 1.
    pub batch_size: u64,
    /// `ceil(total_rows / batch_size)`.
    pub batches: u64,
    /// false => the SQL cannot be safely rewritten for paging.
    pub can_paginate: bool,
    /// Present iff `can_paginate` is false; user-facing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub const THROTTLE_NO_NUMBERS_REASON: &str =
    "UCM did not report a row count for this query.";

static TOTAL_ROWS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)total\s+rows\s+matched:\s*(\d+)").unwrap());
// Cisco's docs render the phrase both as "Suggested row fetch" and
// "Suggestive Row Fetch" — `suggest\w*` accepts either. Parse leniently.
static SUGGESTED_FETCH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)suggest\w*\s+row\s+fetch:\s*less\s+than\s*(\d+)").unwrap());

/// Turn a SOAP faultstring into the right error: UCM's 8 MB throttle fault
/// becomes `Throttled` (parsed leniently); everything else stays a verbatim
/// `Fault`.
fn classify_fault(faultstring: String) -> AxlError {
    if !faultstring.to_lowercase().contains("query request too large") {
        return AxlError::Fault(faultstring);
    }
    let capture = |re: &Regex| {
        re.captures(&faultstring)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse::<u64>().ok())
    };
    let info = match (capture(&TOTAL_ROWS_RE), capture(&SUGGESTED_FETCH_RE)) {
        (Some(total_rows), Some(suggested_fetch)) => {
            // "less than M" is exclusive -> start at M - 1, clamped to >= 1.
            let batch_size = suggested_fetch.saturating_sub(1).max(1);
            ThrottleInfo {
                total_rows,
                suggested_fetch,
                batch_size,
                batches: total_rows.div_ceil(batch_size),
                can_paginate: true,
                reason: None,
            }
        }
        _ => ThrottleInfo {
            total_rows: 0,
            suggested_fetch: 0,
            batch_size: 0,
            batches: 0,
            can_paginate: false,
            reason: Some(THROTTLE_NO_NUMBERS_REASON.to_string()),
        },
    };
    AxlError::Throttled(info)
}

/// Connection parameters for a single request. The password is pulled from
/// the OS keychain by the caller and only lives for the duration of the call.
pub struct AxlTarget {
    pub host: String,
    pub username: String,
    pub password: String,
    /// Dotted AXL schema version, e.g. "12.5".
    pub version: String,
    pub verify_tls: bool,
}

/// The SOAPAction header value (unquoted; the transport wraps it in quotes).
pub fn soap_action(version: &str) -> String {
    format!("CUCM:DB ver={version} executeSQLQuery")
}

/// Build the exact executeSQLQuery envelope from the IPC contract.
pub fn build_envelope(version: &str, sql: &str) -> String {
    // A "]]>" inside the SQL would terminate the CDATA section early; split it
    // across two CDATA sections so the payload survives verbatim.
    let sql = sql.replace("]]>", "]]]]><![CDATA[>");
    format!(
        r#"<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="http://www.cisco.com/AXL/API/{version}">
  <soapenv:Header/>
  <soapenv:Body>
    <ns:executeSQLQuery sequence="1">
      <sql><![CDATA[{sql}]]></sql>
    </ns:executeSQLQuery>
  </soapenv:Body>
</soapenv:Envelope>"#
    )
}

/// Parse an executeSQLQueryResponse (or SOAP Fault) body.
///
/// Matching is on local names only. Zero rows (`<return/>` or absent
/// `return`) is a success with empty columns/rows. Empty elements become "".
pub fn parse_response(xml: &str) -> Result<QueryResult, AxlError> {
    let mut reader = Reader::from_str(xml);

    let mut rows_raw: Vec<Vec<(String, String)>> = Vec::new();
    let mut current_row: Option<Vec<(String, String)>> = None;
    // (column name, accumulated text) for the cell currently being read.
    let mut current_cell: Option<(String, String)> = None;
    // Depth of nested markup inside the current cell (we keep only its text).
    let mut cell_depth = 0usize;

    let mut saw_fault = false;
    let mut in_faultstring = false;
    let mut fault_buf = String::new();
    let mut fault_string: Option<String> = None;

    loop {
        match reader.read_event() {
            Err(e) => return Err(AxlError::Parse(e.to_string())),
            Ok(Event::Eof) => break,
            Ok(Event::Start(e)) => {
                let local = local_name_of(e.name().local_name().as_ref());
                if current_cell.is_some() {
                    cell_depth += 1;
                } else if current_row.is_some() {
                    current_cell = Some((local, String::new()));
                    cell_depth = 0;
                } else if local == "row" {
                    current_row = Some(Vec::new());
                } else if local == "Fault" {
                    saw_fault = true;
                } else if saw_fault && fault_string.is_none() && local == "faultstring" {
                    in_faultstring = true;
                    fault_buf.clear();
                }
            }
            Ok(Event::Empty(e)) => {
                let local = local_name_of(e.name().local_name().as_ref());
                if current_cell.is_some() {
                    // Nested empty element inside a cell: contributes no text.
                } else if let Some(row) = current_row.as_mut() {
                    // Empty element <foo/> => "".
                    row.push((local, String::new()));
                } else if local == "row" {
                    rows_raw.push(Vec::new());
                }
            }
            Ok(Event::End(e)) => {
                let local = local_name_of(e.name().local_name().as_ref());
                if in_faultstring && local == "faultstring" {
                    in_faultstring = false;
                    fault_string = Some(fault_buf.clone());
                } else if current_cell.is_some() {
                    if cell_depth > 0 {
                        cell_depth -= 1;
                    } else if let Some((name, text)) = current_cell.take() {
                        if let Some(row) = current_row.as_mut() {
                            row.push((name, text));
                        }
                    }
                } else if local == "row" {
                    if let Some(row) = current_row.take() {
                        rows_raw.push(row);
                    }
                }
            }
            Ok(Event::Text(t)) => {
                let text = t
                    .unescape()
                    .map_err(|e| AxlError::Parse(e.to_string()))?;
                if in_faultstring {
                    fault_buf.push_str(&text);
                } else if let Some((_, buf)) = current_cell.as_mut() {
                    buf.push_str(&text);
                }
            }
            Ok(Event::CData(t)) => {
                let bytes = t.into_inner();
                let text = String::from_utf8_lossy(&bytes);
                if in_faultstring {
                    fault_buf.push_str(&text);
                } else if let Some((_, buf)) = current_cell.as_mut() {
                    buf.push_str(&text);
                }
            }
            Ok(_) => {}
        }
    }

    if let Some(fs) = fault_string {
        return Err(AxlError::Fault(fs.trim().to_string()));
    }

    // Column order: first row's element order; union in extras from later
    // rows, appended at the end, so nothing is silently dropped.
    let mut columns: Vec<String> = Vec::new();
    for row in &rows_raw {
        for (name, _) in row {
            if !columns.iter().any(|c| c == name) {
                columns.push(name.clone());
            }
        }
    }

    let rows: Vec<Row> = rows_raw
        .into_iter()
        .map(|cells| cells.into_iter().collect())
        .collect();

    Ok(QueryResult { columns, rows })
}

/// quick-xml's `local_name()` already strips the prefix; this is a defensive
/// second pass (and converts bytes to an owned String).
fn local_name_of(name: &[u8]) -> String {
    let s = String::from_utf8_lossy(name);
    match s.rsplit(':').next() {
        Some(local) => local.to_string(),
        None => s.into_owned(),
    }
}

/// POST one executeSQLQuery to a UCM and parse the result.
///
/// The reqwest client is built per request from the UCM record: when
/// `verify_tls` is false, invalid/self-signed certs are accepted (lab
/// default); when true, certs are verified normally.
pub async fn execute_sql_query(
    target: &AxlTarget,
    sql: &str,
    timeout_secs: u64,
) -> Result<QueryResult, AxlError> {
    // Hosts coming from the frontend never carry a port (the contract fixes
    // AXL at 8443). An explicit "host:port" is honored so tests can point at
    // a mock server on a different port.
    let url = if target.host.contains(':') {
        format!("https://{}/axl/", target.host)
    } else {
        format!("https://{}:8443/axl/", target.host)
    };

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!target.verify_tls)
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| AxlError::Parse(format!("could not build HTTP client: {e}")))?;

    let map_send_err = |e: reqwest::Error| {
        if e.is_timeout() {
            AxlError::Timeout(timeout_secs)
        } else {
            // connect / DNS / TLS failure
            AxlError::Connect(target.host.clone())
        }
    };

    let response = client
        .post(&url)
        .basic_auth(&target.username, Some(&target.password))
        .header("Content-Type", "text/xml; charset=utf-8")
        .header("SOAPAction", format!("\"{}\"", soap_action(&target.version)))
        .body(build_envelope(&target.version, sql))
        .send()
        .await
        .map_err(map_send_err)?;

    let status = response.status();
    match status.as_u16() {
        401 => return Err(AxlError::Unauthorized),
        403 => return Err(AxlError::Forbidden),
        // Cisco documents 503 as UCM's request-throttling response.
        503 => return Err(AxlError::ServiceUnavailable),
        _ => {}
    }

    let body = response.text().await.map_err(map_send_err)?;

    if status.is_success() {
        parse_response(&body).map_err(|e| match e {
            AxlError::Fault(fault) => classify_fault(fault),
            other => other,
        })
    } else {
        // AXL reports SOAP Faults with HTTP 500; prefer the faultstring
        // (classified, so the 8 MB throttle fault becomes `Throttled`).
        if let Err(AxlError::Fault(fault)) = parse_response(&body) {
            return Err(classify_fault(fault));
        }
        Err(AxlError::Http(
            status.as_u16(),
            status.canonical_reason().unwrap_or("").to_string(),
        ))
    }
}

// ---- Informix paging (the remedy for UCM's 8 MB throttle) ----

/// A word token from a light SQL scan: lowercased text, byte range, and the
/// parenthesis depth it appeared at. Quoted strings ('...', with '' escapes)
/// and quoted identifiers ("...") are skipped entirely.
struct SqlToken {
    text: String,
    start: usize,
    end: usize,
    depth: usize,
}

fn sql_tokens(sql: &str) -> Vec<SqlToken> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut depth = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            quote @ (b'\'' | b'"') => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == quote {
                        // A doubled quote is an escape; stay in the literal.
                        if bytes.get(i + 1) == Some(&quote) {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1; // past the closing quote (or EOF)
            }
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            c if c.is_ascii_alphanumeric() || c == b'_' => {
                let start = i;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                tokens.push(SqlToken {
                    text: sql[start..i].to_ascii_lowercase(),
                    start,
                    end: i,
                    depth,
                });
            }
            _ => i += 1,
        }
    }
    tokens
}

/// Rewrite a SELECT for Informix paging: inject `SKIP {skip} FIRST {first} `
/// before the select list (after ALL/DISTINCT/UNIQUE when present).
/// Deliberately conservative — refusing with a user-facing reason beats
/// silently corrupting a query.
pub fn paginate_sql(sql: &str, skip: u64, first: u64) -> Result<String, String> {
    // Trim whitespace and any trailing semicolons.
    let mut s = sql.trim();
    while let Some(stripped) = s.strip_suffix(';') {
        s = stripped.trim_end();
    }

    let tokens = sql_tokens(s);

    // Must literally begin with the SELECT keyword (word boundary).
    if !tokens
        .first()
        .is_some_and(|t| t.start == 0 && t.text == "select")
    {
        return Err("Only SELECT statements can be fetched in batches.".to_string());
    }

    // A top-level set operator means SKIP/FIRST would apply to a single arm,
    // silently changing the result. (Inside parentheses or string literals
    // the words are harmless.)
    if tokens
        .iter()
        .any(|t| t.depth == 0 && matches!(t.text.as_str(), "union" | "intersect" | "minus"))
    {
        return Err(
            "Queries with UNION, INTERSECT, or MINUS can't be paginated automatically."
                .to_string(),
        );
    }

    // Injection point: right after SELECT, or after ALL / DISTINCT / UNIQUE.
    let mut inject_after = tokens[0].end;
    let mut next = 1;
    if let Some(tok) = tokens.get(next) {
        if matches!(tok.text.as_str(), "all" | "distinct" | "unique") {
            inject_after = tok.end;
            next += 1;
        }
    }
    // Never double-inject over an existing row limit.
    if let Some(tok) = tokens.get(next) {
        if matches!(tok.text.as_str(), "skip" | "first" | "limit") {
            return Err(
                "The query already limits rows with SKIP/FIRST/LIMIT — edit it manually instead."
                    .to_string(),
            );
        }
    }

    Ok(format!(
        "{} SKIP {skip} FIRST {first} {}",
        &s[..inject_after],
        s[inject_after..].trim_start()
    ))
}

/// Progress snapshot handed to the batch callback after each completed batch.
#[derive(Debug, Clone, Copy)]
pub struct BatchProgress {
    /// 1-based index of the batch that just completed.
    pub batch_index: u64,
    /// Best current estimate of the total number of batches.
    pub batches: u64,
    /// Rows accumulated so far.
    pub fetched: u64,
    /// Best current estimate of the total row count.
    pub total: u64,
}

/// Maximum number of adaptive batch-size halvings before giving up.
pub const MAX_HALVINGS: u32 = 5;

/// Fetch a throttled query in SKIP/FIRST batches, merging every page into a
/// single result (columns are the union across batches, in first-seen
/// order). `total_hint` — from the original throttle fault — drives the
/// progress estimates until the server tells us better.
///
/// Row sizes vary, so UCM's suggested batch size is only an estimate: if a
/// batch itself throttles, the batch size is halved and the SAME batch
/// retried, up to [`MAX_HALVINGS`] times; subsequent batches continue at the
/// reduced size. If it still throttles at the floor, the throttle error is
/// returned.
pub async fn fetch_batched(
    target: &AxlTarget,
    sql: &str,
    initial_batch_size: u64,
    total_hint: Option<u64>,
    timeout_secs: u64,
    mut on_batch: impl FnMut(BatchProgress),
) -> Result<QueryResult, AxlError> {
    let mut batch = initial_batch_size.max(1);
    let mut total = total_hint;
    let mut halvings = 0u32;
    let mut skip: u64 = 0;
    let mut batch_index: u64 = 0;
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Row> = Vec::new();

    loop {
        let paged = paginate_sql(sql, skip, batch).map_err(AxlError::Fault)?;
        match execute_sql_query(target, &paged, timeout_secs).await {
            Ok(page) => {
                let got = page.rows.len() as u64;
                for col in page.columns {
                    if !columns.contains(&col) {
                        columns.push(col);
                    }
                }
                rows.extend(page.rows);
                batch_index += 1;
                skip += got;
                let fetched = rows.len() as u64;

                // A short (or empty) page is definitive; a known total also
                // lets us skip a trailing empty request.
                let done = got < batch || total.is_some_and(|t| fetched >= t);

                let (batches, total_est) = match total {
                    Some(t) => {
                        let remaining = t.saturating_sub(fetched);
                        (batch_index + remaining.div_ceil(batch), t.max(fetched))
                    }
                    None if done => (batch_index, fetched),
                    None => (batch_index + 1, fetched),
                };
                on_batch(BatchProgress {
                    batch_index,
                    batches,
                    fetched,
                    total: total_est,
                });

                if done {
                    return Ok(QueryResult { columns, rows });
                }
            }
            Err(AxlError::Throttled(info)) => {
                // The fault itself reports the real total; adopt it.
                if info.total_rows > 0 {
                    total = Some(info.total_rows);
                }
                if halvings >= MAX_HALVINGS || batch == 1 {
                    return Err(AxlError::Throttled(info));
                }
                halvings += 1;
                batch = (batch / 2).max(1);
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1. Envelope construction: exact XML, namespace, and SOAPAction.
    #[test]
    fn envelope_is_exact_for_version_and_sql() {
        let envelope = build_envelope("12.5", "select pkid from device");
        let expected = "<soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:ns=\"http://www.cisco.com/AXL/API/12.5\">\n  <soapenv:Header/>\n  <soapenv:Body>\n    <ns:executeSQLQuery sequence=\"1\">\n      <sql><![CDATA[select pkid from device]]></sql>\n    </ns:executeSQLQuery>\n  </soapenv:Body>\n</soapenv:Envelope>";
        assert_eq!(envelope, expected);
        assert!(envelope.contains("xmlns:ns=\"http://www.cisco.com/AXL/API/12.5\""));
        assert_eq!(soap_action("12.5"), "CUCM:DB ver=12.5 executeSQLQuery");
    }

    #[test]
    fn envelope_uses_the_requested_version_everywhere() {
        let envelope = build_envelope("9.1", "select 1 from dual");
        assert!(envelope.contains("xmlns:ns=\"http://www.cisco.com/AXL/API/9.1\""));
        assert_eq!(soap_action("9.1"), "CUCM:DB ver=9.1 executeSQLQuery");
    }

    // 2. Normal multi-row response: ordered columns + rows.
    #[test]
    fn parses_multi_row_response() {
        let xml = "<soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\"><soapenv:Body><ns:executeSQLQueryResponse xmlns:ns=\"http://www.cisco.com/AXL/API/12.5\"><return><row><pkid>x</pkid><name>y</name></row><row><pkid>a</pkid><name>b</name></row></return></ns:executeSQLQueryResponse></soapenv:Body></soapenv:Envelope>";
        let result = parse_response(xml).unwrap();
        assert_eq!(result.columns, vec!["pkid", "name"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0]["pkid"], "x");
        assert_eq!(result.rows[0]["name"], "y");
        assert_eq!(result.rows[1]["pkid"], "a");
        assert_eq!(result.rows[1]["name"], "b");
    }

    // 3. Row 2 has an extra column not present in row 1: appended, not dropped.
    #[test]
    fn extra_column_in_later_row_is_appended() {
        let xml = "<soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\"><soapenv:Body><ns:executeSQLQueryResponse xmlns:ns=\"http://www.cisco.com/AXL/API/12.5\"><return><row><pkid>x</pkid><name>y</name></row><row><pkid>a</pkid><name>b</name><description>extra</description></row></return></ns:executeSQLQueryResponse></soapenv:Body></soapenv:Envelope>";
        let result = parse_response(xml).unwrap();
        assert_eq!(result.columns, vec!["pkid", "name", "description"]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[1]["description"], "extra");
        assert!(!result.rows[0].contains_key("description"));
    }

    // 4a. Self-closing <return/> => empty rows, empty columns, NOT an error.
    #[test]
    fn empty_return_element_is_success_with_no_rows() {
        let xml = "<soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\"><soapenv:Body><ns:executeSQLQueryResponse xmlns:ns=\"http://www.cisco.com/AXL/API/12.5\"><return/></ns:executeSQLQueryResponse></soapenv:Body></soapenv:Envelope>";
        let result = parse_response(xml).unwrap();
        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
    }

    // 4b. Absent <return> entirely => also success with no rows.
    #[test]
    fn absent_return_element_is_success_with_no_rows() {
        let xml = "<soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\"><soapenv:Body><ns:executeSQLQueryResponse xmlns:ns=\"http://www.cisco.com/AXL/API/12.5\"></ns:executeSQLQueryResponse></soapenv:Body></soapenv:Envelope>";
        let result = parse_response(xml).unwrap();
        assert!(result.columns.is_empty());
        assert!(result.rows.is_empty());
    }

    // 5. Empty elements <foo/> parse as "".
    #[test]
    fn empty_element_parses_as_empty_string() {
        let xml = "<soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\"><soapenv:Body><ns:executeSQLQueryResponse xmlns:ns=\"http://www.cisco.com/AXL/API/12.5\"><return><row><pkid>x</pkid><description/></row></return></ns:executeSQLQueryResponse></soapenv:Body></soapenv:Envelope>";
        let result = parse_response(xml).unwrap();
        assert_eq!(result.columns, vec!["pkid", "description"]);
        assert_eq!(result.rows[0]["description"], "");
        // An open/close pair with no text is also "".
        let xml2 = "<soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\"><soapenv:Body><ns:executeSQLQueryResponse xmlns:ns=\"http://www.cisco.com/AXL/API/12.5\"><return><row><pkid>x</pkid><description></description></row></return></ns:executeSQLQueryResponse></soapenv:Body></soapenv:Envelope>";
        let result2 = parse_response(xml2).unwrap();
        assert_eq!(result2.rows[0]["description"], "");
    }

    // 6. SOAP Fault: the faultstring is extracted as the error message.
    #[test]
    fn soap_fault_yields_faultstring_as_error() {
        let xml = "<soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\"><soapenv:Body><soapenv:Fault><faultcode>soapenv:Server</faultcode><faultstring>A syntax error has occurred. The SQL statement could not be parsed.</faultstring><detail><axlError><axlcode>201</axlcode></axlError></detail></soapenv:Fault></soapenv:Body></soapenv:Envelope>";
        let err = parse_response(xml).unwrap_err();
        assert_eq!(
            err,
            AxlError::Fault(
                "A syntax error has occurred. The SQL statement could not be parsed.".to_string()
            )
        );
    }

    // 7. Different namespace prefixes (SOAP-ENV:/axl:) still parse.
    #[test]
    fn parses_with_different_namespace_prefixes() {
        let xml = "<SOAP-ENV:Envelope xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\"><SOAP-ENV:Body><axl:executeSQLQueryResponse xmlns:axl=\"http://www.cisco.com/AXL/API/8.5\"><return><row><pkid>x</pkid><name>y</name></row></return></axl:executeSQLQueryResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>";
        let result = parse_response(xml).unwrap();
        assert_eq!(result.columns, vec!["pkid", "name"]);
        assert_eq!(result.rows[0]["pkid"], "x");
        assert_eq!(result.rows[0]["name"], "y");
    }

    // 7b. A prefixed Fault (SOAP-ENV:Fault) is still detected by local name.
    #[test]
    fn parses_prefixed_fault() {
        let xml = "<SOAP-ENV:Envelope xmlns:SOAP-ENV=\"http://schemas.xmlsoap.org/soap/envelope/\"><SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>SOAP-ENV:Client</faultcode><faultstring>The specified table (foo) is not in the database.</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>";
        let err = parse_response(xml).unwrap_err();
        assert_eq!(
            err,
            AxlError::Fault("The specified table (foo) is not in the database.".to_string())
        );
    }

    // Extras: values with XML entities and CDATA survive; "]]>" in SQL is safe.
    #[test]
    fn entity_and_cdata_values_are_decoded() {
        let xml = "<soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\"><soapenv:Body><ns:executeSQLQueryResponse xmlns:ns=\"http://www.cisco.com/AXL/API/12.5\"><return><row><name>Tom &amp; Jerry</name><desc><![CDATA[a <b> c]]></desc></row></return></ns:executeSQLQueryResponse></soapenv:Body></soapenv:Envelope>";
        let result = parse_response(xml).unwrap();
        assert_eq!(result.rows[0]["name"], "Tom & Jerry");
        assert_eq!(result.rows[0]["desc"], "a <b> c");
    }

    #[test]
    fn cdata_terminator_in_sql_is_split() {
        let envelope = build_envelope("12.5", "select ']]>' from dual");
        assert!(!envelope.contains("<![CDATA[select ']]>' from dual]]>"));
        assert!(envelope.contains("]]]]><![CDATA[>"));
    }

    #[test]
    fn error_messages_match_the_contract() {
        assert_eq!(
            AxlError::Connect("cucm1".into()).to_string(),
            "Could not connect to cucm1 — check the address and that AXL is reachable on port 8443."
        );
        assert_eq!(
            AxlError::Unauthorized.to_string(),
            "Unauthorized — check the AXL username and password."
        );
        assert_eq!(
            AxlError::Forbidden.to_string(),
            "Forbidden — the account lacks the 'Standard AXL API Access' role."
        );
        assert_eq!(AxlError::Timeout(60).to_string(), "Query timed out after 60s.");
        assert_eq!(
            AxlError::Http(503, "Service Unavailable".into()).to_string(),
            "AXL returned HTTP 503 Service Unavailable."
        );
    }
    // ---- throttle fault classification ----

    #[test]
    fn throttle_fault_parses_both_documented_wordings() {
        for wording in ["Suggested row fetch", "Suggestive Row Fetch"] {
            let err = classify_fault(format!(
                "Query request too large. Total rows matched: 2816 rows. {wording}: less than 844 rows"
            ));
            let AxlError::Throttled(info) = err else {
                panic!("expected Throttled for wording {wording:?}");
            };
            assert_eq!(info.total_rows, 2816);
            assert_eq!(info.suggested_fetch, 844);
            assert_eq!(info.batch_size, 843, "exclusive bound: less than 844 -> 843");
            assert_eq!(info.batches, 4);
            assert!(info.can_paginate);
            assert_eq!(info.reason, None);
        }
    }

    #[test]
    fn throttle_fault_without_numbers_is_not_paginatable() {
        let err = classify_fault("Query request too large.".to_string());
        let AxlError::Throttled(info) = err else {
            panic!("expected Throttled");
        };
        assert!(!info.can_paginate);
        assert_eq!(info.reason.as_deref(), Some(THROTTLE_NO_NUMBERS_REASON));
    }

    #[test]
    fn throttle_batch_size_clamps_to_at_least_one() {
        let err = classify_fault(
            "Query request too large. Total rows matched: 5 rows. Suggested row fetch: less than 1 rows"
                .to_string(),
        );
        let AxlError::Throttled(info) = err else {
            panic!("expected Throttled");
        };
        assert_eq!(info.batch_size, 1);
        assert_eq!(info.batches, 5);
    }

    #[test]
    fn non_throttle_fault_stays_a_verbatim_fault() {
        let err = classify_fault("A syntax error has occurred.".to_string());
        assert_eq!(
            err,
            AxlError::Fault("A syntax error has occurred.".to_string())
        );
    }

    #[test]
    fn service_unavailable_message_matches_the_addendum() {
        assert_eq!(
            AxlError::ServiceUnavailable.to_string(),
            "UCM is throttling requests right now (HTTP 503) — wait a moment and retry."
        );
    }

    // ---- paginate_sql ----

    #[test]
    fn paginate_plain_select() {
        assert_eq!(
            paginate_sql("SELECT * FROM device", 0, 843).unwrap(),
            "SELECT SKIP 0 FIRST 843 * FROM device"
        );
    }

    #[test]
    fn paginate_injects_after_all_distinct_unique() {
        assert_eq!(
            paginate_sql("SELECT DISTINCT name FROM device", 843, 843).unwrap(),
            "SELECT DISTINCT SKIP 843 FIRST 843 name FROM device"
        );
        assert_eq!(
            paginate_sql("select all name from device", 0, 10).unwrap(),
            "select all SKIP 0 FIRST 10 name from device"
        );
        assert_eq!(
            paginate_sql("select unique name from device", 0, 10).unwrap(),
            "select unique SKIP 0 FIRST 10 name from device"
        );
    }

    #[test]
    fn paginate_lowercase_select() {
        assert_eq!(
            paginate_sql("select pkid from device", 10, 20).unwrap(),
            "select SKIP 10 FIRST 20 pkid from device"
        );
    }

    #[test]
    fn paginate_strips_trailing_semicolons_and_whitespace() {
        assert_eq!(
            paginate_sql("  select pkid from device ; ", 0, 5).unwrap(),
            "select SKIP 0 FIRST 5 pkid from device"
        );
        assert_eq!(
            paginate_sql("select pkid from device;;", 0, 5).unwrap(),
            "select SKIP 0 FIRST 5 pkid from device"
        );
    }

    #[test]
    fn paginate_refuses_top_level_set_operators() {
        assert!(paginate_sql("select a from t1 union select b from t2", 0, 5).is_err());
        assert!(paginate_sql("select a from t1 UNION ALL select b from t2", 0, 5).is_err());
        assert!(paginate_sql("select a from t1 INTERSECT select b from t2", 0, 5).is_err());
        assert!(paginate_sql("select a from t1 minus select b from t2", 0, 5).is_err());
        // ... but not when the word only appears inside a string literal
        assert!(paginate_sql("select a from t1 where name = 'union'", 0, 5).is_ok());
        // ... or inside parentheses (a subquery arm, not the top level)
        assert!(
            paginate_sql(
                "select a from (select b from t2 union select c from t3) s",
                0,
                5
            )
            .is_ok()
        );
    }

    #[test]
    fn paginate_refuses_existing_row_limits() {
        assert!(paginate_sql("select first 10 pkid from device", 0, 5).is_err());
        assert!(paginate_sql("select skip 5 pkid from device", 0, 5).is_err());
        assert!(paginate_sql("SELECT LIMIT 10 pkid FROM device", 0, 5).is_err());
        assert!(paginate_sql("select distinct first 10 pkid from device", 0, 5).is_err());
    }

    #[test]
    fn paginate_refuses_non_select_statements() {
        assert!(paginate_sql("update device set name = 'x'", 0, 5).is_err());
        assert!(paginate_sql("delete from device", 0, 5).is_err());
        assert!(paginate_sql("", 0, 5).is_err());
        // "selection" starts with "select" but is not the SELECT keyword.
        assert!(paginate_sql("selection from device", 0, 5).is_err());
    }
}

/// End-to-end tests against a live instance of the vendored mock AXL server
/// (`tests/mock_axl.py`). The fixture spawns the mock itself on a free port
/// and blocks until its READY line appears, so `cargo test` is hermetic —
/// nothing needs to be running beforehand. The mock serves real HTTPS with a
/// self-signed cert, so these tests also exercise the `verify_tls = false`
/// path. If `python3` or `openssl` is unavailable on this machine, the tests
/// skip with a message instead of failing.
#[cfg(test)]
mod live_mock_tests {
    use super::*;
    use std::io::BufRead;
    use std::net::TcpListener;
    use std::process::{Child, Command, Stdio};
    use std::sync::OnceLock;

    struct Mock {
        /// "127.0.0.1:<port>"
        host: String,
        /// Held so the child handle stays alive; the mock process is
        /// intentionally leaked for the lifetime of the test run (its worker
        /// threads are daemons, so it dies cleanly with the test process's
        /// pipes closed and never blocks the run).
        _child: Child,
    }

    enum MockState {
        Ready(Mock),
        SkippedMissingTools,
        Failed(String),
    }

    static MOCK: OnceLock<MockState> = OnceLock::new();

    fn tool_works(cmd: &str, arg: &str) -> bool {
        Command::new(cmd)
            .arg(arg)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Bind to :0 to let the OS pick a free port, then release it. The tiny
    /// release-to-spawn race is acceptable for tests.
    fn free_port() -> std::io::Result<u16> {
        Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
    }

    fn start_mock() -> MockState {
        // The mock needs python3, and shells out to openssl for its cert.
        if !tool_works("python3", "--version") || !tool_works("openssl", "version") {
            return MockState::SkippedMissingTools;
        }

        let port = match free_port() {
            Ok(p) => p,
            Err(e) => return MockState::Failed(format!("could not pick a free port: {e}")),
        };

        let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mock_axl.py");
        let mut child = match Command::new("python3")
            .arg(script)
            .arg(port.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => return MockState::Failed(format!("could not spawn {script}: {e}")),
        };

        // Block until the readiness line appears (cert generation takes a
        // moment) — with a deadline, not a blind sleep.
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            return MockState::Failed("mock stdout was not captured".to_string());
        };
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.contains("READY") {
                    let _ = tx.send(());
                    return;
                }
            }
        });
        match rx.recv_timeout(std::time::Duration::from_secs(30)) {
            Ok(()) => MockState::Ready(Mock {
                host: format!("127.0.0.1:{port}"),
                _child: child,
            }),
            Err(_) => {
                let _ = child.kill();
                MockState::Failed("mock never printed its READY line within 30s".to_string())
            }
        }
    }

    /// The shared mock's host:port. Panics on fixture failures (those are
    /// bugs worth failing loudly on); returns None only when the tools to
    /// run the mock are missing, so tests can skip instead of failing.
    fn mock_host() -> Option<&'static str> {
        match MOCK.get_or_init(start_mock) {
            MockState::Ready(mock) => Some(mock.host.as_str()),
            MockState::SkippedMissingTools => None,
            MockState::Failed(msg) => panic!("mock AXL server failed to start: {msg}"),
        }
    }

    macro_rules! mock_or_skip {
        () => {
            match mock_host() {
                Some(host) => host,
                None => {
                    eprintln!(
                        "skipping live mock test: python3/openssl not available to run tests/mock_axl.py"
                    );
                    return;
                }
            }
        };
    }

    fn target_for(host: &str, user: &str, pass: &str) -> AxlTarget {
        AxlTarget {
            host: host.to_string(),
            username: user.to_string(),
            password: pass.to_string(),
            version: "12.5".to_string(),
            verify_tls: false, // self-signed cert
        }
    }

    async fn run_ok(host: &str, sql: &str) -> Result<QueryResult, AxlError> {
        execute_sql_query(&target_for(host, "axluser", "axlpass"), sql, 30).await
    }

    #[tokio::test]
    async fn mock_normal_rows() {
        let host = mock_or_skip!();
        let r = run_ok(host, "select * from device").await.unwrap();
        assert_eq!(r.columns, vec!["pkid", "name", "description"]);
        assert_eq!(r.rows.len(), 3);
        assert_eq!(r.rows[0]["pkid"], "aaa-111");
        assert_eq!(r.rows[0]["name"], "SEP001122334455");
        assert_eq!(r.rows[2]["description"], "Conf Room A");
    }

    #[tokio::test]
    async fn mock_ragged_rows_keep_extra_column() {
        let host = mock_or_skip!();
        let r = run_ok(host, "select ragged").await.unwrap();
        assert_eq!(r.columns, vec!["pkid", "name", "extra"]);
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.rows[1]["extra"], "SURPRISE");
        assert!(!r.rows[0].contains_key("extra"));
    }

    #[tokio::test]
    async fn mock_zero_row_variants_are_success() {
        let host = mock_or_skip!();
        for sql in ["select empty", "select selfclosed", "select noreturn"] {
            let r = run_ok(host, sql)
                .await
                .unwrap_or_else(|e| panic!("{sql} failed: {e}"));
            assert!(r.rows.is_empty(), "{sql}: expected no rows");
            assert!(r.columns.is_empty(), "{sql}: expected no columns");
        }
    }

    #[tokio::test]
    async fn mock_null_values_become_empty_strings() {
        let host = mock_or_skip!();
        let r = run_ok(host, "select nulls").await.unwrap();
        assert_eq!(r.columns, vec!["pkid", "name", "description"]);
        assert_eq!(r.rows[0]["name"], "");
        assert_eq!(r.rows[0]["description"], "has empty name");
    }

    #[tokio::test]
    async fn mock_weird_namespace_prefixes_still_parse() {
        let host = mock_or_skip!();
        let r = run_ok(host, "select weirdns").await.unwrap();
        assert_eq!(r.columns, vec!["pkid", "name"]);
        assert_eq!(r.rows[0]["pkid"], "ns-ok");
        assert_eq!(r.rows[0]["name"], "WeirdPrefix");
    }

    #[tokio::test]
    async fn mock_big_result_set() {
        let host = mock_or_skip!();
        let r = run_ok(host, "select big").await.unwrap();
        assert_eq!(r.rows.len(), 20000);
        assert_eq!(r.columns, vec!["pkid", "name", "description"]);
        assert_eq!(r.rows[19999]["pkid"], "pk-19999");
    }

    #[tokio::test]
    async fn mock_soap_fault_maps_to_faultstring() {
        let host = mock_or_skip!();
        let err = run_ok(host, "select fault").await.unwrap_err();
        assert_eq!(
            err,
            AxlError::Fault("Syntax error in SQL statement near 'FROM'".to_string())
        );
    }

    #[tokio::test]
    async fn mock_unexpected_http_status_maps_to_http_error() {
        let host = mock_or_skip!();
        let err = run_ok(host, "select teapot").await.unwrap_err();
        assert!(matches!(err, AxlError::Http(418, _)), "got: {err}");
        assert!(err.to_string().starts_with("AXL returned HTTP 418"));
    }

    #[tokio::test]
    async fn mock_wrong_password_maps_to_unauthorized() {
        let host = mock_or_skip!();
        let err = execute_sql_query(
            &target_for(host, "axluser", "wrongpass"),
            "select * from device",
            30,
        )
        .await
        .unwrap_err();
        assert_eq!(err, AxlError::Unauthorized);
    }

    #[tokio::test]
    async fn mock_forbidden_user_maps_to_forbidden() {
        let host = mock_or_skip!();
        let err = execute_sql_query(
            &target_for(host, "forbidden", "whatever"),
            "select * from device",
            30,
        )
        .await
        .unwrap_err();
        assert_eq!(err, AxlError::Forbidden);
    }

    #[tokio::test]
    async fn mock_connection_refused_maps_to_connect_error() {
        // A port the OS just handed back with nothing listening on it.
        let port = free_port().expect("could not pick a free port");
        let err = execute_sql_query(
            &target_for(&format!("127.0.0.1:{port}"), "axluser", "axlpass"),
            "select * from device",
            10,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AxlError::Connect(_)), "got: {err}");
    }

    #[tokio::test]
    async fn mock_slow_response_maps_to_timeout() {
        // The threaded mock keeps serving other tests while this handler
        // sleeps 90s server-side; the client gives up after 2s.
        let host = mock_or_skip!();
        let err = execute_sql_query(&target_for(host, "axluser", "axlpass"), "select slow", 2)
            .await
            .unwrap_err();
        assert_eq!(err, AxlError::Timeout(2));
        assert_eq!(err.to_string(), "Query timed out after 2s.");
    }

    // ---- 8 MB throttle handling (contract addendum) ----

    // Addendum test 1: unpaged `select * from throttle` -> Throttled with
    // totalRows 2816, suggestedFetch 844, batchSize 843, batches 4.
    #[tokio::test]
    async fn mock_throttle_fault_parses_into_throttle_info() {
        let host = mock_or_skip!();
        let err = run_ok(host, "select * from throttle").await.unwrap_err();
        let AxlError::Throttled(info) = err else {
            panic!("expected AxlError::Throttled, got: {err}");
        };
        assert_eq!(info.total_rows, 2816);
        assert_eq!(info.suggested_fetch, 844);
        assert_eq!(info.batch_size, 843);
        assert_eq!(info.batches, 4);
        assert!(info.can_paginate);
        assert_eq!(info.reason, None);
    }

    // Addendum test 2: the "Suggestive Row Fetch" wording parses identically.
    #[tokio::test]
    async fn mock_throttle_alt_wording_parses_identically() {
        let host = mock_or_skip!();
        let err = run_ok(host, "select * from throttlealt").await.unwrap_err();
        let AxlError::Throttled(info) = err else {
            panic!("expected AxlError::Throttled, got: {err}");
        };
        assert_eq!(info.total_rows, 2816);
        assert_eq!(info.suggested_fetch, 844);
        assert_eq!(info.batch_size, 843);
        assert_eq!(info.batches, 4);
        assert!(info.can_paginate);
    }

    // Addendum test 3: a throttle fault without parseable numbers is still a
    // throttle, but canPaginate=false with a user-facing reason.
    #[tokio::test]
    async fn mock_throttle_without_numbers_cannot_paginate() {
        let host = mock_or_skip!();
        let err = run_ok(host, "select * from throttlenonum").await.unwrap_err();
        let AxlError::Throttled(info) = err else {
            panic!("expected AxlError::Throttled, got: {err}");
        };
        assert!(!info.can_paginate);
        assert_eq!(info.reason.as_deref(), Some(THROTTLE_NO_NUMBERS_REASON));
    }

    // Addendum test 4 — the core guarantee: a full batched fetch returns
    // exactly 2816 rows, pk-0 through pk-2815, in order, with no duplicates
    // and no gaps.
    #[tokio::test]
    async fn mock_batched_fetch_returns_every_row_in_order() {
        let host = mock_or_skip!();
        let target = target_for(host, "axluser", "axlpass");
        let mut progress: Vec<BatchProgress> = Vec::new();
        let r = fetch_batched(
            &target,
            "select * from throttle",
            843,
            Some(2816),
            30,
            |p| progress.push(p),
        )
        .await
        .unwrap();

        assert_eq!(r.columns, vec!["pkid", "name", "description"]);
        assert_eq!(r.rows.len(), 2816, "expected exactly 2816 rows");
        for (i, row) in r.rows.iter().enumerate() {
            assert_eq!(
                row["pkid"],
                format!("pk-{i}"),
                "row {i} is out of sequence (duplicate or gap)"
            );
        }

        // 4 batches of 843 + 843 + 843 + 287, with stable total/batch counts.
        assert_eq!(progress.len(), 4);
        assert_eq!(
            progress.iter().map(|p| p.fetched).collect::<Vec<_>>(),
            vec![843, 1686, 2529, 2816]
        );
        assert_eq!(
            progress.iter().map(|p| p.batch_index).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        assert!(progress.iter().all(|p| p.batches == 4 && p.total == 2816));
    }

    // Addendum test 5: an oversized initial batch (900 > 843) throttles,
    // halves to 450, and still completes with the full ordered row set.
    #[tokio::test]
    async fn mock_batched_fetch_halves_oversized_batches() {
        let host = mock_or_skip!();
        let target = target_for(host, "axluser", "axlpass");
        let mut progress: Vec<BatchProgress> = Vec::new();
        let r = fetch_batched(&target, "select * from throttle", 900, None, 30, |p| {
            progress.push(p)
        })
        .await
        .unwrap();

        assert_eq!(r.rows.len(), 2816);
        for (i, row) in r.rows.iter().enumerate() {
            assert_eq!(row["pkid"], format!("pk-{i}"), "row {i} out of sequence");
        }
        // 900 -> throttle -> halved to 450: ceil(2816 / 450) = 7 batches.
        assert_eq!(progress.len(), 7);
        assert_eq!(progress[0].fetched, 450);
        // The retry's throttle fault taught us the real total despite no hint.
        assert_eq!(progress[0].total, 2816);
        assert_eq!(progress[0].batches, 7);
        assert_eq!(progress.last().unwrap().fetched, 2816);
    }

    // Addendum test 6: HTTP 503 maps to the request-throttling message.
    #[tokio::test]
    async fn mock_http_503_maps_to_service_unavailable() {
        let host = mock_or_skip!();
        let err = run_ok(host, "select unavailable").await.unwrap_err();
        assert_eq!(err, AxlError::ServiceUnavailable);
        assert_eq!(
            err.to_string(),
            "UCM is throttling requests right now (HTTP 503) — wait a moment and retry."
        );
    }
}
