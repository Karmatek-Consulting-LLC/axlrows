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
- **Throttle handling** -- UCM caps `executeSQLQuery` responses at 8 MB. When a query
  trips that cap, AXLRows reads the row count out of the fault and offers to fetch the
  whole set in batches. See [Large result sets](#large-result-sets).
- **Favorites** -- name, save, edit, and re-run queries.
- **Servers** -- add/edit/delete UCM publishers, per-server TLS verification toggle,
  and a connection test that reports latency.
- **Keyboard-first** -- `Ctrl/Cmd+Enter` runs, `Ctrl/Cmd+K` opens the command palette,
  `Ctrl/Cmd+1/2/3` switches views.
- **Light and dark themes**, persisted.

## Large result sets

Cisco UCM caps `executeSQLQuery` responses at **8 MB of data** (not a row count) and
rejects anything larger with a SOAP fault:

```
Query request too large. Total rows matched: 2816 rows. Suggested row fetch: less than 844 rows
```

SeaQuill surfaced this as a dead end. AXLRows parses the fault and offers a one-click
**Fetch all 2,816 in 17 batches**, which re-runs the query with Informix
`SELECT SKIP n FIRST m` paging and merges the batches back into the grid. Rows from
other publishers in the same run are left untouched.

- **The batch size is UCM's suggested row fetch divided by 5.** The suggestion is an
  estimate derived from average row width and is not reliable: batches sized close to
  it routinely re-throttle on wide rows, which is the worst thing to do to a publisher
  that has just told you it's overloaded. The 5x margin is what a decade of production
  use against this API converged on. Do not "optimize" it back toward the suggestion.
- As a backstop below that, the batch size also **halves adaptively** if a batch does
  still throttle. In practice the 5x margin means it never fires.
- Batching is cancellable, and progress is reported per batch.
- Queries that can't be rewritten safely (a top-level `UNION`/`INTERSECT`/`MINUS`, or
  one that already has its own `SKIP`/`FIRST`/`LIMIT`) are not paginated. AXLRows says
  why instead of silently mangling your SQL.
- **Auto-fetch throttled queries in batches** is available as a setting, off by
  default -- so a query matching millions of rows can't quietly fire thousands of
  requests at a production publisher.

A note on ordering: Informix does not guarantee a stable row order across
`SKIP`/`FIRST` batches unless the query has an `ORDER BY`, so in theory a batched
fetch could duplicate or drop rows. In a decade of practice against UCM this has not
been a problem -- UCM config tables are effectively static while you query them -- so
AXLRows does not require or inject an `ORDER BY`. Add one if you want the guarantee.

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

### macOS

```bash
xcode-select --install                                              # linker + python3
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh      # Rust
brew install node                                                   # or nvm install 22
npm install && npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/macos/AXLRows.app` and
`.../bundle/dmg/`. The build targets the host architecture; for a universal binary:

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

On first run macOS asks whether AXLRows may read its Keychain entries — choose
**Always Allow**. A locally built app is only ad-hoc signed, and that signature
changes on every rebuild, so macOS will ask again after each `tauri build`. That's
expected, not a bug. Distributing the `.dmg` to another Mac would need a Developer ID
signature and notarization; running your own build needs neither.

### Windows

Install the [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
and [Rust](https://rustup.rs), then `npm install && npm run tauri build`. Produces an
`.msi` and an `.exe` installer under `src-tauri/target/release/bundle/`.

### Linux build dependencies:

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
