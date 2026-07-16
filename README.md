<p align="center">
  <b>AXLRows</b><br>
  <i>Send SQL to Cisco UCM over AXL. Work with the results like a grown-up.</i>
</p>

---

AXLRows is a desktop app for network engineers who query the Cisco Unified CM
database via the AXL `executeSQLQuery` API. Write SQL, fan it out to as many
publishers as you like, and get every row back in one sortable, filterable,
exportable grid.

It is a ground-up rewrite of [SeaQuill](https://github.com/sloan58/seaquill)
(Electron + React 16 + Bootstrap) on **Tauri v2 + React 19 + TypeScript**.

## Why the rewrite

| | SeaQuill (Electron) | AXLRows (Tauri) |
|---|---|---|
| Installer size | ~200 MB | **~7 MB** (`.deb` / `.rpm`), 79 MB AppImage |
| AXL client | `strong-soap` + 40 bundled WSDL/XSD files (~30 MB) | hand-built SOAP envelope in Rust, **zero schema files** |
| Passwords | plaintext JSON on disk | **OS keychain** (Keychain / Credential Manager / libsecret) |
| Result set | paginated Bootstrap table | **virtualized grid**, 20k rows rendered in ~107 ms |
| Query timeout | 5s, hardcoded | 60s, configurable |
| Per-target progress | one global spinner | live per-server status, row counts, latency |

The 30 MB of AXL schemas existed only because `strong-soap` needed a WSDL to
build a client. `executeSQLQuery` is a single SOAP envelope whose only
version-dependent part is the namespace -- `http://www.cisco.com/AXL/API/{version}`.
Constructing it directly in Rust deleted the entire schema tree.

## Features

- **Multi-target queries** -- one SQL statement, N publishers, executed concurrently.
  Each target reports independently; one server 401ing doesn't kill the run.
- **Results grid** -- sort, per-column filter, global search, column visibility,
  CSV export via a native save dialog. Every row is tagged with the UCM it came from.
- **Favorites** -- name, save, edit, and re-run queries.
- **Servers** -- add/edit/delete UCM publishers, per-server TLS verification toggle,
  and a connection test that reports latency.
- **Keyboard-first** -- `Ctrl/Cmd+Enter` runs, `Ctrl/Cmd+K` opens the command palette,
  `Ctrl/Cmd+1/2/3` switches views.
- **Light and dark themes**, persisted.

## Security

Passwords are **never** written to SQLite and are **never** returned to the
frontend. They live in the OS keychain, keyed by `io.karmatek.axlrows` +
the server's UUID. The SQLite database holds only non-secret metadata.

`Verify TLS certificate` is **off by default**, matching typical lab UCM
deployments with self-signed certs -- but unlike the old app, which silently
disabled verification for every request, it is per-server and visible in the UI.
Turn it on for production publishers.

## Install

Grab a bundle from `src-tauri/target/release/bundle/` after building, or:

```bash
sudo dpkg -i AXLRows_0.1.0_amd64.deb     # Debian/Ubuntu
sudo rpm -i AXLRows-0.1.0-1.x86_64.rpm   # Fedora/RHEL
chmod +x AXLRows_0.1.0_amd64.AppImage    # anywhere
```

On Linux, a Secret Service provider (`gnome-keyring`, KWallet, etc.) is required
for password storage. The app tells you if one isn't available rather than
silently falling back to plaintext.

## Build from source

Requires [Rust](https://rustup.rs) and Node 20+.

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # release + installers for the host platform
```

Linux build dependencies:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
                 librsvg2-dev libxdo-dev libssl-dev build-essential curl file patchelf
```

Cross-platform installers (`.dmg`, `.msi`/`.exe`) are produced by running
`npm run tauri build` on macOS and Windows respectively; Tauri does not
cross-compile bundles.

## Tests

```bash
cd src-tauri && cargo test
```

29 tests. The AXL client is tested against `src-tauri/tests/mock_axl.py`, a fake
UCM that speaks real HTTPS + SOAP with a self-signed cert. The test fixture
spawns it automatically -- no setup required. It covers the happy path, 401/403,
SOAP faults, timeouts, ragged rows, three flavors of zero-row response,
alternate XML namespace prefixes, and a 20,000-row payload.

## Architecture

```
src/                  React 19 + TypeScript + Vite
  lib/ipc.ts          the only file that touches invoke()/listen()
  lib/mock.ts         dev-only fake backend (browser, never ships)
  stores/             Zustand
  views/              Query, Servers, Favorites
src-tauri/
  src/axl.rs          SOAP envelope + response parser + error mapping
  src/query.rs        concurrent fan-out, per-target events, cancellation
  src/db.rs           SQLite (metadata only)
  src/creds.rs        OS keychain
  src/export.rs       CSV + native save dialog
```

`run_query` returns a run ID immediately and streams
`query://target-started`, `query://target-success`, `query://target-error`,
and `query://complete` events as each server responds.

## Credits

- Original SeaQuill by [Marty Sloan](https://github.com/sloan58).
- Bob Sloan for the original SeaQuill logo.

## License

MIT -- see [LICENSE.md](LICENSE.md).
