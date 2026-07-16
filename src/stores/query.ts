import { create } from "zustand";
import { toast } from "sonner";
import { ipc } from "../lib/ipc";
import { errMsg, fmtCount, fmtMs } from "../lib/utils";
import type {
  QueryCompletePayload,
  Row,
  TargetBatchProgressPayload,
  TargetErrorPayload,
  TargetStartedPayload,
  TargetSuccessPayload,
  TargetThrottledPayload,
  ThrottleInfo,
} from "../lib/types";
import { useUcmsStore } from "./ucms";
import { useUiStore } from "./ui";

export type TargetStatus = "pending" | "running" | "ok" | "error" | "throttled";

/** Live progress of a batched re-fetch (`query://target-batch-progress`). */
export interface BatchProgress {
  batchIndex: number; // 1-based
  batches: number;
  fetched: number;
  total: number;
}

export interface TargetState {
  ucmId: string;
  ucmName: string;
  status: TargetStatus;
  rowCount: number | null;
  elapsedMs: number | null;
  message: string | null;
  /** UCM's 8 MB cap details — set while status === "throttled". */
  throttle: ThrottleInfo | null;
  /** Batched-fetch progress — set once the first batch completes. */
  batch: BatchProgress | null;
}

/**
 * A grid row: the raw UCM row plus its origin. The backend deliberately
 * injects no synthetic column (see CONTRACT.md) — we tag origin client-side
 * from the event payload, keeping it out of the cell namespace so a real
 * column named "ucm" can never collide.
 */
export interface GridRow {
  ucmId: string;
  ucmName: string;
  cells: Row;
}

interface QueryState {
  sql: string;
  setSql: (sql: string) => void;
  targetIds: string[];
  setTargetIds: (ids: string[]) => void;
  toggleTarget: (id: string) => void;

  runId: string | null;
  running: boolean;
  runStartedAt: number | null;
  /** SQL snapshot of the current run — the editor may change afterwards, but
   * a batched re-fetch must page the query that actually throttled. */
  runSql: string | null;
  targets: TargetState[];
  columns: string[]; // union across successful targets, first-seen order
  rows: GridRow[];
  summary: QueryCompletePayload | null;

  run: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Re-fetch ONE throttled target in SKIP/FIRST batches inside the same run. */
  fetchBatched: (ucmId: string) => Promise<void>;
  clearEditor: () => void;
  clearResults: () => void;

  // Event ingress — wired once in App.tsx.
  _onStarted: (p: TargetStartedPayload) => void;
  _onSuccess: (p: TargetSuccessPayload) => void;
  _onError: (p: TargetErrorPayload) => void;
  _onThrottled: (p: TargetThrottledPayload) => void;
  _onBatchProgress: (p: TargetBatchProgressPayload) => void;
  _onComplete: (p: QueryCompletePayload) => void;
}

// The backend returns runId from `run_query` immediately, but per-target
// events are emitted from concurrently spawned tasks — an event can land
// before the invoke promise resolves. Buffer events that arrive while the
// runId is still unknown, then replay them once it's set.
type BufferedEvent =
  | { kind: "started"; p: TargetStartedPayload }
  | { kind: "success"; p: TargetSuccessPayload }
  | { kind: "error"; p: TargetErrorPayload }
  | { kind: "throttled"; p: TargetThrottledPayload }
  | { kind: "batch"; p: TargetBatchProgressPayload }
  | { kind: "complete"; p: QueryCompletePayload };

let awaitingRunId = false;
let eventBuffer: BufferedEvent[] = [];

/** Any target still in flight? A batched re-fetch runs AFTER `query://complete`,
 * so `running` must be derived from target states once the run has settled. */
const stillActive = (targets: TargetState[]) =>
  targets.some((t) => t.status === "pending" || t.status === "running");

export const useQueryStore = create<QueryState>((set, get) => ({
  sql: "",
  setSql: (sql) => set({ sql }),
  targetIds: [],
  setTargetIds: (targetIds) => set({ targetIds }),
  toggleTarget: (id) => {
    const cur = get().targetIds;
    set({ targetIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },

  runId: null,
  running: false,
  runStartedAt: null,
  runSql: null,
  targets: [],
  columns: [],
  rows: [],
  summary: null,

  run: async () => {
    const { sql, targetIds, running } = get();
    if (running) return;
    if (!sql.trim()) {
      toast.warning("Nothing to run", { description: "Write a SQL query first." });
      return;
    }
    if (targetIds.length === 0) {
      toast.warning("No targets selected", { description: "Pick at least one UCM to query." });
      return;
    }
    const byId = new Map(useUcmsStore.getState().ucms.map((u) => [u.id, u]));
    const targets: TargetState[] = targetIds.map((id) => ({
      ucmId: id,
      ucmName: byId.get(id)?.name ?? id,
      status: "pending",
      rowCount: null,
      elapsedMs: null,
      message: null,
      throttle: null,
      batch: null,
    }));
    set({
      running: true,
      runStartedAt: Date.now(),
      runSql: sql,
      targets,
      columns: [],
      rows: [],
      summary: null,
      runId: null,
    });
    awaitingRunId = true;
    eventBuffer = [];
    try {
      const runId = await ipc.runQuery(sql, targetIds);
      set({ runId });
      awaitingRunId = false;
      // Replay events that beat the invoke response.
      const buffered = eventBuffer;
      eventBuffer = [];
      for (const ev of buffered) {
        if (ev.kind === "started") get()._onStarted(ev.p);
        else if (ev.kind === "success") get()._onSuccess(ev.p);
        else if (ev.kind === "error") get()._onError(ev.p);
        else if (ev.kind === "throttled") get()._onThrottled(ev.p);
        else if (ev.kind === "batch") get()._onBatchProgress(ev.p);
        else get()._onComplete(ev.p);
      }
    } catch (e) {
      awaitingRunId = false;
      eventBuffer = [];
      set({ running: false, targets: [] });
      toast.error("Query failed to start", { description: errMsg(e) });
    }
  },

  cancel: async () => {
    const { runId } = get();
    if (!runId) return;
    try {
      await ipc.cancelQuery(runId);
      toast.info("Cancelling run…");
    } catch (e) {
      toast.error("Cancel failed", { description: errMsg(e) });
    }
  },

  fetchBatched: async (ucmId) => {
    const { runId, runSql, targets } = get();
    const target = targets.find((t) => t.ucmId === ucmId);
    const throttle = target?.throttle;
    if (!runId || runSql === null || !target || target.status !== "throttled") return;
    if (!throttle?.canPaginate) return;
    // Optimistic: the chip goes back to a queued state until the backend's
    // `target-started` lands. Keep `throttle` so a failed invoke can restore it.
    set({
      running: true,
      runStartedAt: Date.now(), // LiveElapsed ticks from the re-fetch, not the old run
      targets: get().targets.map((t) =>
        t.ucmId === ucmId ? { ...t, status: "pending", message: null, batch: null } : t,
      ),
    });
    try {
      await ipc.fetchTargetBatched(runId, ucmId, runSql, throttle.batchSize);
    } catch (e) {
      const restored = get().targets.map((t) =>
        t.ucmId === ucmId && t.status === "pending"
          ? { ...t, status: "throttled" as const, throttle }
          : t,
      );
      set({ targets: restored, running: stillActive(restored) });
      toast.error("Batched fetch failed to start", { description: errMsg(e) });
    }
  },

  clearEditor: () => set({ sql: "" }),
  clearResults: () =>
    set({
      targets: [],
      columns: [],
      rows: [],
      summary: null,
      runId: null,
      runSql: null,
      running: false,
    }),

  _onStarted: (p) => {
    if (awaitingRunId) {
      eventBuffer.push({ kind: "started", p });
      return;
    }
    if (p.runId !== get().runId) return;
    set({
      targets: get().targets.map((t) =>
        t.ucmId === p.ucmId
          ? {
              ...t,
              status: "running",
              rowCount: null,
              elapsedMs: null,
              message: null,
              throttle: null,
              batch: null,
            }
          : t,
      ),
    });
  },

  _onSuccess: (p) => {
    if (awaitingRunId) {
      eventBuffer.push({ kind: "success", p });
      return;
    }
    if (p.runId !== get().runId) return;
    const state = get();
    // Union new columns after existing ones, preserving first-seen order.
    const seen = new Set(state.columns);
    const added = p.columns.filter((c) => !seen.has(c));
    const tagged: GridRow[] = p.rows.map((cells) => ({
      ucmId: p.ucmId,
      ucmName: p.ucmName,
      cells,
    }));
    // A success after the run completed is a batched re-fetch: it carries the
    // FULL row set for that one UCM, so drop anything it previously
    // contributed. Other targets' rows are never touched.
    const isRefetch = state.summary !== null;
    const base = isRefetch ? state.rows.filter((r) => r.ucmId !== p.ucmId) : state.rows;
    const wasBatch = state.targets.find((t) => t.ucmId === p.ucmId)?.batch ?? null;
    const targets = state.targets.map((t) =>
      t.ucmId === p.ucmId
        ? {
            ...t,
            status: "ok" as const,
            rowCount: p.rows.length,
            elapsedMs: p.elapsedMs,
            message: null,
            throttle: null,
            batch: null,
          }
        : t,
    );
    set({
      columns: added.length ? [...state.columns, ...added] : state.columns,
      rows: tagged.length ? [...base, ...tagged] : base,
      targets,
      running: isRefetch ? stillActive(targets) : state.running,
    });
    if (isRefetch) {
      toast.success(`${p.ucmName} — fetched ${fmtCount(p.rows.length)} rows`, {
        description: wasBatch
          ? `${wasBatch.batches} batches in ${fmtMs(p.elapsedMs)}.`
          : `Completed in ${fmtMs(p.elapsedMs)}.`,
      });
    }
  },

  _onError: (p) => {
    if (awaitingRunId) {
      eventBuffer.push({ kind: "error", p });
      return;
    }
    if (p.runId !== get().runId) return;
    const state = get();
    const targets = state.targets.map((t) =>
      t.ucmId === p.ucmId
        ? {
            ...t,
            status: "error" as const,
            elapsedMs: p.elapsedMs,
            message: p.message,
            throttle: null,
            batch: null,
          }
        : t,
    );
    set({ targets, running: state.summary ? stillActive(targets) : state.running });
  },

  _onThrottled: (p) => {
    if (awaitingRunId) {
      eventBuffer.push({ kind: "throttled", p });
      return;
    }
    if (p.runId !== get().runId) return;
    const state = get();
    const targets = state.targets.map((t) =>
      t.ucmId === p.ucmId
        ? {
            ...t,
            status: "throttled" as const,
            rowCount: null,
            elapsedMs: p.elapsedMs,
            message: null,
            throttle: p.throttle,
            batch: null,
          }
        : t,
    );
    set({ targets, running: state.summary ? stillActive(targets) : state.running });
    if (p.throttle.canPaginate && useUiStore.getState().autoBatch) {
      void get().fetchBatched(p.ucmId);
    }
  },

  _onBatchProgress: (p) => {
    if (awaitingRunId) {
      eventBuffer.push({ kind: "batch", p });
      return;
    }
    if (p.runId !== get().runId) return;
    set({
      targets: get().targets.map((t) =>
        t.ucmId === p.ucmId
          ? {
              ...t,
              batch: {
                batchIndex: p.batchIndex,
                batches: p.batches,
                fetched: p.fetched,
                total: p.total,
              },
            }
          : t,
      ),
    });
  },

  _onComplete: (p) => {
    if (awaitingRunId) {
      eventBuffer.push({ kind: "complete", p });
      return;
    }
    if (p.runId !== get().runId) return;
    // A throttled target may already be auto-batch-fetching — derive `running`
    // from target states instead of unconditionally clearing it.
    set({ running: stillActive(get().targets), summary: p });
    const rows = fmtCount(p.totalRows);
    if (p.errCount === 0 && p.throttledCount === 0) {
      toast.success(`Run complete — ${rows} rows`, {
        description: `${p.okCount}/${p.okCount} targets succeeded.`,
      });
    } else if (p.okCount === 0 && p.throttledCount === 0) {
      toast.error("Run failed on every target", {
        description: `${p.errCount} target${p.errCount > 1 ? "s" : ""} errored.`,
      });
    } else {
      const parts = [
        p.okCount > 0 && `${p.okCount} succeeded`,
        p.throttledCount > 0 && `${p.throttledCount} hit UCM's 8 MB cap`,
        p.errCount > 0 && `${p.errCount} failed`,
      ]
        .filter(Boolean)
        .join(", ");
      toast.warning(`Run finished — ${rows} rows`, { description: `${parts}.` });
    }
  },
}));
