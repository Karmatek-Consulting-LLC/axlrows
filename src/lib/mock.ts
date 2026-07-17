// Dev-only in-browser mock of the Tauri backend. Lets `npm run dev` exercise
// the full UI: fake UCMs, streaming query results, per-target failures,
// a 20k-row payload and a zero-row target. Never active inside Tauri
// (see the gate in ipc.ts).

import type { IpcClient, UnlistenFn } from "./ipc";
import type {
  Favorite,
  QueryCompletePayload,
  Row,
  TargetBatchProgressPayload,
  TargetErrorPayload,
  TargetStartedPayload,
  TargetSuccessPayload,
  TargetThrottledPayload,
  Ucm,
} from "./types";

const nowIso = () => new Date().toISOString();
const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `mock-${Math.random().toString(36).slice(2)}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);

// ---- seed data --------------------------------------------------------

type MockUcm = Ucm & {
  /** Scripted behavior for query runs. */
  behavior: "big" | "medium" | "unauthorized" | "empty" | "throttle" | "throttle-nopage";
  password: string | null;
};

let ucms: MockUcm[] = [
  {
    id: "u-hq-pub",
    name: "HQ-PUB",
    host: "10.10.20.1",
    username: "axladmin",
    version: "15.0",
    verifyTls: false,
    hasPassword: true,
    createdAt: "2026-01-12T09:30:00Z",
    behavior: "big",
    password: "secret",
  },
  {
    id: "u-west-pub",
    name: "WEST-PUB",
    host: "cucm-west.corp.example",
    username: "axladmin",
    version: "14.0",
    verifyTls: true,
    hasPassword: true,
    createdAt: "2026-02-02T14:05:00Z",
    behavior: "medium",
    password: "secret",
  },
  {
    id: "u-lab",
    name: "LAB-12",
    host: "192.168.99.10",
    username: "administrator",
    version: "12.5",
    verifyTls: false,
    hasPassword: true,
    createdAt: "2026-03-19T21:44:00Z",
    behavior: "unauthorized",
    password: "wrong",
  },
  {
    id: "u-dr",
    name: "DR-PUB",
    host: "10.40.20.1",
    username: "axladmin",
    version: "15.0",
    verifyTls: false,
    hasPassword: true,
    createdAt: "2026-04-07T08:12:00Z",
    behavior: "empty",
    password: "secret",
  },
  {
    id: "u-eu-pub",
    name: "EU-PUB",
    host: "cucm-eu.corp.example",
    username: "axladmin",
    version: "15.0",
    verifyTls: true,
    hasPassword: true,
    createdAt: "2026-05-14T11:02:00Z",
    behavior: "throttle", // 8 MB cap: 2816 rows matched, batches of 168
    password: "secret",
  },
  {
    id: "u-apac-pub",
    name: "APAC-PUB",
    host: "10.60.20.1",
    username: "axladmin",
    version: "14.0",
    verifyTls: false,
    hasPassword: true,
    createdAt: "2026-06-01T07:40:00Z",
    behavior: "throttle-nopage", // throttled AND the SQL can't be paginated
    password: "secret",
  },
];

let favorites: Favorite[] = [
  {
    id: "f-1",
    name: "Registered phones",
    sql: "SELECT d.name, d.description, tp.name AS model\nFROM device d\nJOIN typemodel tp ON tp.enum = d.tkmodel\nWHERE d.tkclass = 1\nORDER BY d.name",
    createdAt: "2026-05-01T10:00:00Z",
    updatedAt: "2026-06-11T16:20:00Z",
  },
  {
    id: "f-2",
    name: "End users with DNs",
    sql: "SELECT eu.userid, eu.firstname, eu.lastname, np.dnorpattern\nFROM enduser eu\nJOIN endusernumplanmap map ON map.fkenduser = eu.pkid\nJOIN numplan np ON np.pkid = map.fknumplan",
    createdAt: "2026-05-20T12:00:00Z",
    updatedAt: "2026-05-20T12:00:00Z",
  },
];

const strip = (u: MockUcm): Ucm => ({
  id: u.id,
  name: u.name,
  host: u.host,
  username: u.username,
  version: u.version,
  verifyTls: u.verifyTls,
  hasPassword: u.hasPassword,
  createdAt: u.createdAt,
});

// ---- fake result payloads ---------------------------------------------

const MODELS = ["Cisco 8845", "Cisco 8865", "Cisco 7841", "Cisco 8811", "Jabber CSF", "Webex Desk"];
const POOLS = ["HQ_DP", "WEST_DP", "BRANCH_DP", "DR_DP"];
const STATUS = ["Registered", "Unregistered", "Rejected", ""];

function bigRows(n: number, site: string): { columns: string[]; rows: Row[] } {
  const columns = ["pkid", "name", "description", "devicepool", "model", "status", "ipaddress", "lastseen"];
  const rows: Row[] = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = {
      pkid: `${site.toLowerCase()}-${(100000 + i).toString(16)}`,
      name: `SEP${(0xa0000000000 + i * 7919).toString(16).toUpperCase().slice(0, 12)}`,
      description: `${site} phone ${i + 1}`,
      devicepool: POOLS[i % POOLS.length],
      model: MODELS[i % MODELS.length],
      status: STATUS[i % STATUS.length],
      ipaddress: i % 11 === 0 ? "" : `10.${(i >> 8) & 255}.${i & 255}.${(i % 250) + 1}`,
      lastseen: new Date(Date.now() - i * 60_000).toISOString().slice(0, 19),
    };
  }
  return { columns, rows };
}

// WEST returns a *different* shape (extra column, missing one) to exercise
// the column-union behavior in the grid.
function mediumRows(n: number): { columns: string[]; rows: Row[] } {
  const columns = ["pkid", "name", "description", "devicepool", "model", "loadinformation"];
  const rows: Row[] = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = {
      pkid: `west-${(200000 + i).toString(16)}`,
      name: `SEP${(0xb0000000000 + i * 104729).toString(16).toUpperCase().slice(0, 12)}`,
      description: i % 7 === 0 ? "" : `West branch ${i % 40} desk ${i}`,
      devicepool: POOLS[(i + 1) % POOLS.length],
      model: MODELS[(i + 3) % MODELS.length],
      loadinformation: `sip88xx.12-0-1ES${i % 9}`,
    };
  }
  return { columns, rows };
}

// The throttling target mirrors the verified mock_axl.py facts: 2816 rows
// matched, "less than 844" suggested. The batch size applies the same /5 safety
// margin the backend uses (UCM's suggestion is an unreliable estimate), so:
// batchSize 168 -> 17 batches of 168 x 16 + 128, pkids pk-0 .. pk-2815.
const THROTTLE_TOTAL = 2816;
// Mirrors THROTTLE_SAFETY_DIVISOR in the Rust backend. UCM's suggested row fetch
// is an estimate from average row width and batches sized to it still get
// rejected; /5 is the margin the owner's production PHP app has used for years.
const THROTTLE_SAFETY_DIVISOR = 5;
const THROTTLE_SUGGESTED = 844;
const THROTTLE_COLUMNS = ["pkid", "name", "description", "devicepool", "model", "status"];

function throttleInfo(canPaginate: boolean, reason?: string) {
  const batchSize = Math.max(1, Math.floor(THROTTLE_SUGGESTED / THROTTLE_SAFETY_DIVISOR));
  return {
    totalRows: THROTTLE_TOTAL,
    suggestedFetch: THROTTLE_SUGGESTED,
    batchSize,
    batches: Math.ceil(THROTTLE_TOTAL / batchSize),
    canPaginate,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** One SKIP/FIRST page of the throttled target's 2816-row result set. */
function throttlePage(skip: number, first: number): Row[] {
  const end = Math.min(skip + first, THROTTLE_TOTAL);
  const rows: Row[] = [];
  for (let i = skip; i < end; i++) {
    rows.push({
      pkid: `pk-${i}`,
      name: `SEP${(0xc0000000000 + i * 6151).toString(16).toUpperCase().slice(0, 12)}`,
      description: i % 13 === 0 ? "" : `EU phone ${i + 1}`,
      devicepool: POOLS[i % POOLS.length],
      model: MODELS[(i + 2) % MODELS.length],
      status: STATUS[i % STATUS.length],
    });
  }
  return rows;
}

// ---- event plumbing ----------------------------------------------------

type Handler<T> = (p: T) => void;
const listeners = {
  started: new Set<Handler<TargetStartedPayload>>(),
  success: new Set<Handler<TargetSuccessPayload>>(),
  error: new Set<Handler<TargetErrorPayload>>(),
  throttled: new Set<Handler<TargetThrottledPayload>>(),
  batch: new Set<Handler<TargetBatchProgressPayload>>(),
  complete: new Set<Handler<QueryCompletePayload>>(),
};
const on = <T>(set: Set<Handler<T>>, cb: Handler<T>): Promise<UnlistenFn> => {
  set.add(cb);
  return Promise.resolve(() => set.delete(cb));
};
const emit = <T>(set: Set<Handler<T>>, p: T) => set.forEach((cb) => cb(p));

const cancelled = new Set<string>();

interface TargetOutcome {
  ok: boolean;
  rows: number;
  throttled?: boolean;
}

async function runTarget(
  runId: string,
  ucm: MockUcm,
  sql: string,
  timeoutSecs: number,
): Promise<TargetOutcome> {
  await sleep(rand(60, 350));
  if (cancelled.has(runId)) return { ok: false, rows: 0 };
  emit(listeners.started, { runId, ucmId: ucm.id, ucmName: ucm.name });

  const started = performance.now();
  // "small" anywhere in the SQL keeps the big target modest — handy in dev.
  const bigN = /\bsmall\b/i.test(sql) ? 320 : 20_000;
  let outcome: TargetOutcome;

  switch (ucm.behavior) {
    case "big": {
      await sleep(rand(1200, 2600));
      if (cancelled.has(runId)) return timeoutErr(runId, ucm, started, timeoutSecs);
      const n = bigN;
      const { columns, rows } = bigRows(n, "HQ");
      emit(listeners.success, {
        runId, ucmId: ucm.id, ucmName: ucm.name, columns, rows,
        elapsedMs: Math.round(performance.now() - started),
      });
      outcome = { ok: true, rows: n };
      break;
    }
    case "medium": {
      await sleep(rand(500, 1400));
      if (cancelled.has(runId)) return timeoutErr(runId, ucm, started, timeoutSecs);
      const { columns, rows } = mediumRows(843);
      emit(listeners.success, {
        runId, ucmId: ucm.id, ucmName: ucm.name, columns, rows,
        elapsedMs: Math.round(performance.now() - started),
      });
      outcome = { ok: true, rows: 843 };
      break;
    }
    case "unauthorized": {
      await sleep(rand(300, 900));
      emit(listeners.error, {
        runId, ucmId: ucm.id, ucmName: ucm.name,
        message: "Unauthorized — check the AXL username and password.",
        elapsedMs: Math.round(performance.now() - started),
      });
      outcome = { ok: false, rows: 0 };
      break;
    }
    case "empty": {
      await sleep(rand(700, 1800));
      if (cancelled.has(runId)) return timeoutErr(runId, ucm, started, timeoutSecs);
      emit(listeners.success, {
        runId, ucmId: ucm.id, ucmName: ucm.name, columns: [], rows: [],
        elapsedMs: Math.round(performance.now() - started),
      });
      outcome = { ok: true, rows: 0 };
      break;
    }
    case "throttle": {
      await sleep(rand(700, 1600));
      if (cancelled.has(runId)) return timeoutErr(runId, ucm, started, timeoutSecs);
      emit(listeners.throttled, {
        runId, ucmId: ucm.id, ucmName: ucm.name,
        elapsedMs: Math.round(performance.now() - started),
        throttle: throttleInfo(true),
      });
      outcome = { ok: false, rows: 0, throttled: true };
      break;
    }
    case "throttle-nopage": {
      await sleep(rand(700, 1600));
      if (cancelled.has(runId)) return timeoutErr(runId, ucm, started, timeoutSecs);
      emit(listeners.throttled, {
        runId, ucmId: ucm.id, ucmName: ucm.name,
        elapsedMs: Math.round(performance.now() - started),
        throttle: throttleInfo(
          false,
          "The query contains a top-level UNION — AXLRows can't rewrite it with SKIP/FIRST safely.",
        ),
      });
      outcome = { ok: false, rows: 0, throttled: true };
      break;
    }
  }
  return outcome;
}

function timeoutErr(
  runId: string,
  ucm: MockUcm,
  started: number,
  timeoutSecs: number,
): TargetOutcome {
  emit(listeners.error, {
    runId, ucmId: ucm.id, ucmName: ucm.name,
    message: `Query timed out after ${timeoutSecs}s.`,
    elapsedMs: Math.round(performance.now() - started),
  });
  return { ok: false, rows: 0 };
}

// ---- the client --------------------------------------------------------

export const mockClient: IpcClient = {
  async listUcms() {
    await sleep(rand(40, 160));
    return ucms.map(strip);
  },

  async createUcm(input) {
    await sleep(rand(60, 180));
    if (!input.name.trim()) throw "Name is required.";
    const u: MockUcm = {
      id: uuid(),
      name: input.name,
      host: input.host,
      username: input.username,
      version: input.version,
      verifyTls: input.verifyTls,
      hasPassword: input.password != null && input.password !== "",
      createdAt: nowIso(),
      behavior: "medium",
      password: input.password ?? null,
    };
    ucms = [...ucms, u];
    return strip(u);
  },

  async updateUcm(id, input) {
    await sleep(rand(60, 180));
    const u = ucms.find((x) => x.id === id);
    if (!u) throw `No UCM with id ${id}`;
    u.name = input.name;
    u.host = input.host;
    u.username = input.username;
    u.version = input.version;
    u.verifyTls = input.verifyTls;
    if (input.password != null && input.password !== "") {
      u.password = input.password;
      u.hasPassword = true;
    }
    return strip(u);
  },

  async deleteUcm(id) {
    await sleep(rand(40, 140));
    ucms = ucms.filter((x) => x.id !== id);
  },

  async testUcm(id) {
    const u = ucms.find((x) => x.id === id);
    if (!u) throw `No UCM with id ${id}`;
    const ms = rand(180, 1400);
    await sleep(ms);
    if (u.behavior === "unauthorized") {
      return {
        ok: false,
        message: "Unauthorized — check the AXL username and password.",
        elapsedMs: Math.round(ms),
      };
    }
    return { ok: true, message: `AXL ${u.version} responded`, elapsedMs: Math.round(ms) };
  },

  async listFavorites() {
    await sleep(rand(40, 140));
    return [...favorites];
  },

  async createFavorite(name, sql) {
    await sleep(rand(40, 140));
    const f: Favorite = { id: uuid(), name, sql, createdAt: nowIso(), updatedAt: nowIso() };
    favorites = [f, ...favorites];
    return f;
  },

  async updateFavorite(id, name, sql) {
    await sleep(rand(40, 140));
    const f = favorites.find((x) => x.id === id);
    if (!f) throw `No favorite with id ${id}`;
    f.name = name;
    f.sql = sql;
    f.updatedAt = nowIso();
    return { ...f };
  },

  async deleteFavorite(id) {
    await sleep(rand(40, 120));
    favorites = favorites.filter((x) => x.id !== id);
  },

  async runQuery(sql, targetIds, timeoutSecs = 60) {
    const runId = uuid();
    const targets = targetIds
      .map((id) => ucms.find((u) => u.id === id))
      .filter((u): u is MockUcm => !!u);
    // Fan out; settle; then complete — mirrors the backend's one-task-per-target.
    void (async () => {
      const results = await Promise.all(targets.map((u) => runTarget(runId, u, sql, timeoutSecs)));
      const okCount = results.filter((r) => r.ok).length;
      const throttledCount = results.filter((r) => r.throttled).length;
      emit(listeners.complete, {
        runId,
        okCount,
        errCount: results.length - okCount - throttledCount,
        throttledCount,
        totalRows: results.reduce((s, r) => s + r.rows, 0),
      });
      cancelled.delete(runId);
    })();
    return runId;
  },

  async cancelQuery(runId) {
    cancelled.add(runId);
  },

  async fetchTargetBatched(runId, ucmId, _sql, batchSize) {
    const ucm = ucms.find((u) => u.id === ucmId);
    if (!ucm) throw `No UCM with id ${ucmId}`;
    if (batchSize < 1) throw "batchSize must be >= 1";
    cancelled.delete(runId); // a fresh fetch inside the existing run
    // Background like run_query: the invoke resolves immediately, rows stream in.
    void (async () => {
      emit(listeners.started, { runId, ucmId: ucm.id, ucmName: ucm.name });
      const started = performance.now();
      const batches = Math.ceil(THROTTLE_TOTAL / batchSize);
      const all: Row[] = [];
      for (let i = 0; i < batches; i++) {
        await sleep(rand(500, 950));
        if (cancelled.has(runId)) {
          emit(listeners.error, {
            runId, ucmId: ucm.id, ucmName: ucm.name,
            message: "Cancelled.",
            elapsedMs: Math.round(performance.now() - started),
          });
          return;
        }
        all.push(...throttlePage(i * batchSize, batchSize));
        emit(listeners.batch, {
          runId, ucmId: ucm.id, ucmName: ucm.name,
          batchIndex: i + 1, batches, fetched: all.length, total: THROTTLE_TOTAL,
        });
      }
      await sleep(250); // let the final batch tick render before the merge
      emit(listeners.success, {
        runId, ucmId: ucm.id, ucmName: ucm.name,
        columns: THROTTLE_COLUMNS, rows: all,
        elapsedMs: Math.round(performance.now() - started),
      });
      // No query://complete — the run already completed (CONTRACT-THROTTLE.md).
    })();
  },

  async exportCsv(columns, rows, suggestedName) {
    await sleep(600); // pretend a save dialog happened
    console.info(`[mock] export_csv: ${columns.length} cols x ${rows.length} rows -> ${suggestedName}`);
    return `/home/marty/Downloads/${suggestedName}`;
  },

  onTargetStarted: (cb) => on(listeners.started, cb),
  onTargetSuccess: (cb) => on(listeners.success, cb),
  onTargetError: (cb) => on(listeners.error, cb),
  onTargetThrottled: (cb) => on(listeners.throttled, cb),
  onTargetBatchProgress: (cb) => on(listeners.batch, cb),
  onQueryComplete: (cb) => on(listeners.complete, cb),
};
