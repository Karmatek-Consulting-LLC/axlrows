#!/usr/bin/env python3
"""
Mock Cisco UCM AXL endpoint for end-to-end testing the AXLRows Rust client.

Speaks real HTTPS on :8443 with a self-signed cert (exercising the verifyTls=false
path exactly like a real lab UCM), Basic auth, and the executeSQLQuery SOAP contract.

Behaviour is driven by the SQL text so one server can exercise every branch:
  SELECT ... FROM device      -> 3 normal rows
  SELECT ... ragged           -> rows where row 2 has a column row 1 lacks
  SELECT ... empty            -> <return></return>  (zero rows, must be SUCCESS not error)
  SELECT ... selfclosed       -> <return/>          (self-closing form)
  SELECT ... noreturn         -> response with no <return> element at all
  SELECT ... nulls            -> empty elements <foo/> -> ""
  SELECT ... fault            -> SOAP Fault with a faultstring
  SELECT ... slow             -> sleeps 90s (timeout path)
  SELECT ... weirdns          -> different namespace prefixes (SOAP-ENV:/axl:)
  SELECT ... big              -> 20000 rows (throughput / virtualization feed)

Credentials: axluser / axlpass. Anything else -> 401.
Username "forbidden" -> 403.

Usage: python3 mock_axl.py [port]
"""
import base64
import re
import ssl
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

GOOD_USER, GOOD_PASS = "axluser", "axlpass"

ENVELOPE = """<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>
<ns:executeSQLQueryResponse xmlns:ns="http://www.cisco.com/AXL/API/12.5">
<return>{rows}</return>
</ns:executeSQLQueryResponse>
</soapenv:Body>
</soapenv:Envelope>"""

WEIRD_NS_ENVELOPE = """<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
<SOAP-ENV:Body>
<axl:executeSQLQueryResponse xmlns:axl="http://www.cisco.com/AXL/API/12.5">
<return><row><pkid>ns-ok</pkid><name>WeirdPrefix</name></row></return>
</axl:executeSQLQueryResponse>
</SOAP-ENV:Body>
</SOAP-ENV:Envelope>"""

SELF_CLOSED = """<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>
<ns:executeSQLQueryResponse xmlns:ns="http://www.cisco.com/AXL/API/12.5">
<return/>
</ns:executeSQLQueryResponse>
</soapenv:Body>
</soapenv:Envelope>"""

NO_RETURN = """<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>
<ns:executeSQLQueryResponse xmlns:ns="http://www.cisco.com/AXL/API/12.5"/>
</soapenv:Body>
</soapenv:Envelope>"""

FAULT = """<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
<soapenv:Body>
<soapenv:Fault>
<faultcode>soapenv:Client</faultcode>
<faultstring>Syntax error in SQL statement near 'FROM'</faultstring>
</soapenv:Fault>
</soapenv:Body>
</soapenv:Envelope>"""


def rows_normal():
    data = [
        ("aaa-111", "SEP001122334455", "Front Desk"),
        ("bbb-222", "SEP001122334466", "Lobby"),
        ("ccc-333", "SEP001122334477", "Conf Room A"),
    ]
    return "".join(
        f"<row><pkid>{p}</pkid><name>{n}</name><description>{d}</description></row>"
        for p, n, d in data
    )


def rows_ragged():
    # row 1 has 2 cols; row 2 introduces a THIRD column that must not be dropped
    return (
        "<row><pkid>aaa-111</pkid><name>First</name></row>"
        "<row><pkid>bbb-222</pkid><name>Second</name><extra>SURPRISE</extra></row>"
    )


def rows_nulls():
    return "<row><pkid>aaa-111</pkid><name/><description>has empty name</description></row>"


def rows_big(n=20000):
    return "".join(
        f"<row><pkid>pk-{i}</pkid><name>SEP{i:012d}</name><description>Device number {i}</description></row>"
        for i in range(n)
    )


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock-axl] " + (fmt % args) + "\n")

    def _send(self, code, body: bytes, ctype="text/xml; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.rstrip("/") != "/axl":
            self._send(404, b"not found", "text/plain")
            return

        auth = self.headers.get("Authorization", "")
        user = pw = None
        if auth.startswith("Basic "):
            try:
                user, pw = base64.b64decode(auth[6:]).decode().split(":", 1)
            except Exception:
                pass

        if user == "forbidden":
            self._send(403, b"Forbidden", "text/plain")
            return
        if user != GOOD_USER or pw != GOOD_PASS:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="AXL"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8", "replace")

        soap_action = self.headers.get("SOAPAction", "")
        self.log_message("SOAPAction=%s", soap_action)

        m = re.search(r"<sql>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</sql>", body, re.S)
        sql = (m.group(1) if m else "").lower()
        self.log_message("sql=%.80s", sql.replace("\n", " "))

        if "fault" in sql:
            self._send(500, FAULT.encode())
        elif "slow" in sql:
            time.sleep(90)
            self._send(200, ENVELOPE.format(rows=rows_normal()).encode())
        elif "weirdns" in sql:
            self._send(200, WEIRD_NS_ENVELOPE.encode())
        elif "selfclosed" in sql:
            self._send(200, SELF_CLOSED.encode())
        elif "noreturn" in sql:
            self._send(200, NO_RETURN.encode())
        elif "empty" in sql:
            self._send(200, ENVELOPE.format(rows="").encode())
        elif "ragged" in sql:
            self._send(200, ENVELOPE.format(rows=rows_ragged()).encode())
        elif "nulls" in sql:
            self._send(200, ENVELOPE.format(rows=rows_nulls()).encode())
        elif "big" in sql:
            self._send(200, ENVELOPE.format(rows=rows_big()).encode())
        elif "teapot" in sql:
            self._send(418, b"I'm a teapot", "text/plain")
        else:
            self._send(200, ENVELOPE.format(rows=rows_normal()).encode())


def make_cert():
    d = Path(tempfile.mkdtemp(prefix="mockaxl-"))
    cert, key = d / "cert.pem", d / "key.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
         "-keyout", str(key), "-out", str(cert), "-days", "2",
         "-subj", "/CN=localhost",
         "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
        check=True, capture_output=True,
    )
    return cert, key


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
    cert, key = make_cert()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cert), str(key))
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    # READY line is the readiness signal for the Rust test harness — keep it stable.
    print(f"[mock-axl] READY https://127.0.0.1:{port}/axl/  (self-signed, {GOOD_USER}/{GOOD_PASS})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
