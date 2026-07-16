//! The AXL SOAP client: envelope construction, HTTP transport, XML response
//! parsing, and error mapping. No WSDL — the envelope is built directly and
//! responses are parsed by matching element LOCAL NAMES only, because
//! namespace prefixes vary across UCM versions.

use std::collections::HashMap;
use std::time::Duration;

use quick_xml::events::Event;
use quick_xml::Reader;
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
        _ => {}
    }

    let body = response.text().await.map_err(map_send_err)?;

    if status.is_success() {
        parse_response(&body)
    } else {
        // AXL reports SOAP Faults with HTTP 500; prefer the faultstring.
        if let Err(AxlError::Fault(fault)) = parse_response(&body) {
            return Err(AxlError::Fault(fault));
        }
        Err(AxlError::Http(
            status.as_u16(),
            status.canonical_reason().unwrap_or("").to_string(),
        ))
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
}
