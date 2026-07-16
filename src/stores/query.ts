import { create } from "zustand";
import { toast } from "sonner";
import { ipc } from "../lib/ipc";
import { errMsg, fmtCount } from "../lib/utils";
import type {
  QueryCompletePayload,
  Row,
  TargetErrorPayload,
  TargetStartedPayload,
  TargetSuccessPayload,
} from "../lib/types";
import { useUcmsStore } from "./ucms";

export type TargetStatus = "pending" | "running" | "ok" | "error";

export interface TargetState {
  ucmId: string;
  ucmName: string;
  status: TargetStatus;
  rowCount: number | null;
  elapsedMs: number | null;
  message: string | null;
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
  targets: TargetState[];
  columns: string[]; // union across successful targets, first-seen order
  rows: GridRow[];
  summary: QueryCompletePayload | null;

  run: () => Promise<void>;
  cancel: () => Promise<void>;
  clearEditor: () => void;
  clearResults: () => void;

  // Event ingress — wired once in App.tsx.
  _onStarted: (p: TargetStartedPayload) => void;
  _onSuccess: (p: TargetSuccessPayload) => void;
  _onError: (p: TargetErrorPayload) => void;
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
  | { kind: "complete"; p: QueryCompletePayload };

let awaitingRunId = false;
let eventBuffer: BufferedEvent[] = [];

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
    }));
    set({
      running: true,
      runStartedAt: Date.now(),
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

  clearEditor: () => set({ sql: "" }),
  clearResults: () =>
    set({ targets: [], columns: [], rows: [], summary: null, runId: null, running: false }),

  _onStarted: (p) => {
    if (awaitingRunId) {
      eventBuffer.push({ kind: "started", p });
      return;
    }
    if (p.runId !== get().runId) return;
    set({
      targets: get().targets.map((t) =>
        t.ucmId === p.ucmId ? { ...t, status: "running" } : t,
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
    set({
      columns: added.length ? [...state.columns, ...added] : state.columns,
      rows: tagged.length ? [...state.rows, ...tagged] : state.rows,
      targets: state.targets.map((t) =>
        t.ucmId === p.ucmId
          ? { ...t, status: "ok", rowCount: p.rows.length, elapsedMs: p.elapsedMs }
          : t,
      ),
    });
  },

  _onError: (p) => {
    if (awaitingRunId) {
      eventBuffer.push({ kind: "error", p });
      return;
    }
    if (p.runId !== get().runId) return;
    set({
      targets: get().targets.map((t) =>
        t.ucmId === p.ucmId
          ? { ...t, status: "error", elapsedMs: p.elapsedMs, message: p.message }
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
    set({ running: false, summary: p });
    const rows = fmtCount(p.totalRows);
    if (p.errCount === 0) {
      toast.success(`Run complete — ${rows} rows`, {
        description: `${p.okCount}/${p.okCount} targets succeeded.`,
      });
    } else if (p.okCount === 0) {
      toast.error("Run failed on every target", {
        description: `${p.errCount} target${p.errCount > 1 ? "s" : ""} errored.`,
      });
    } else {
      toast.warning(`Run finished with errors — ${rows} rows`, {
        description: `${p.okCount} succeeded, ${p.errCount} failed.`,
      });
    }
  },
}));
