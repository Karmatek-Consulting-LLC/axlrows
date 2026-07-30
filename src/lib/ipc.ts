// Thin typed IPC client — the ONLY place `invoke`/`listen` names appear.
// Every name and payload shape mirrors CONTRACT.md exactly.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Favorite,
  QueryCompletePayload,
  Row,
  SchemaInfo,
  TargetBatchProgressPayload,
  TargetErrorPayload,
  TargetStartedPayload,
  TargetSuccessPayload,
  TargetThrottledPayload,
  TestUcmResult,
  Ucm,
  UcmInput,
} from "./types";
import { mockClient } from "./mock";

export type { UnlistenFn };

export interface IpcClient {
  listUcms(): Promise<Ucm[]>;
  createUcm(input: UcmInput): Promise<Ucm>;
  updateUcm(id: string, input: UcmInput): Promise<Ucm>;
  deleteUcm(id: string): Promise<void>;
  testUcm(id: string): Promise<TestUcmResult>;
  /** Introspect one UCM's Informix catalog and cache the result. */
  fetchSchema(id: string): Promise<SchemaInfo>;
  /** Union of every cached server schema; null before any fetch. */
  getSchema(): Promise<SchemaInfo | null>;

  listFavorites(): Promise<Favorite[]>;
  createFavorite(name: string, sql: string): Promise<Favorite>;
  updateFavorite(id: string, name: string, sql: string): Promise<Favorite>;
  deleteFavorite(id: string): Promise<void>;

  runQuery(sql: string, targetIds: string[], timeoutSecs?: number): Promise<string>;
  cancelQuery(runId: string): Promise<void>;
  /** Re-run ONE throttled target of an existing run in SKIP/FIRST batches. */
  fetchTargetBatched(
    runId: string,
    ucmId: string,
    sql: string,
    batchSize: number,
    timeoutSecs?: number,
  ): Promise<void>;
  exportCsv(columns: string[], rows: Row[], suggestedName: string): Promise<string | null>;

  onTargetStarted(cb: (p: TargetStartedPayload) => void): Promise<UnlistenFn>;
  onTargetSuccess(cb: (p: TargetSuccessPayload) => void): Promise<UnlistenFn>;
  onTargetError(cb: (p: TargetErrorPayload) => void): Promise<UnlistenFn>;
  onTargetThrottled(cb: (p: TargetThrottledPayload) => void): Promise<UnlistenFn>;
  onTargetBatchProgress(cb: (p: TargetBatchProgressPayload) => void): Promise<UnlistenFn>;
  onQueryComplete(cb: (p: QueryCompletePayload) => void): Promise<UnlistenFn>;
}

const tauriClient: IpcClient = {
  listUcms: () => invoke<Ucm[]>("list_ucms"),
  createUcm: (input) => invoke<Ucm>("create_ucm", { input }),
  updateUcm: (id, input) => invoke<Ucm>("update_ucm", { id, input }),
  deleteUcm: (id) => invoke<void>("delete_ucm", { id }),
  testUcm: (id) => invoke<TestUcmResult>("test_ucm", { id }),
  fetchSchema: (id) => invoke<SchemaInfo>("fetch_schema", { id }),
  getSchema: () => invoke<SchemaInfo | null>("get_schema"),

  listFavorites: () => invoke<Favorite[]>("list_favorites"),
  createFavorite: (name, sql) => invoke<Favorite>("create_favorite", { name, sql }),
  updateFavorite: (id, name, sql) => invoke<Favorite>("update_favorite", { id, name, sql }),
  deleteFavorite: (id) => invoke<void>("delete_favorite", { id }),

  runQuery: (sql, targetIds, timeoutSecs) =>
    invoke<string>("run_query", { sql, targetIds, timeoutSecs }),
  cancelQuery: (runId) => invoke<void>("cancel_query", { runId }),
  fetchTargetBatched: (runId, ucmId, sql, batchSize, timeoutSecs) =>
    invoke<void>("fetch_target_batched", { runId, ucmId, sql, batchSize, timeoutSecs }),
  exportCsv: (columns, rows, suggestedName) =>
    invoke<string | null>("export_csv", { columns, rows, suggestedName }),

  onTargetStarted: (cb) =>
    listen<TargetStartedPayload>("query://target-started", (e) => cb(e.payload)),
  onTargetSuccess: (cb) =>
    listen<TargetSuccessPayload>("query://target-success", (e) => cb(e.payload)),
  onTargetError: (cb) =>
    listen<TargetErrorPayload>("query://target-error", (e) => cb(e.payload)),
  onTargetThrottled: (cb) =>
    listen<TargetThrottledPayload>("query://target-throttled", (e) => cb(e.payload)),
  onTargetBatchProgress: (cb) =>
    listen<TargetBatchProgressPayload>("query://target-batch-progress", (e) => cb(e.payload)),
  onQueryComplete: (cb) =>
    listen<QueryCompletePayload>("query://complete", (e) => cb(e.payload)),
};

/** True when running inside a real Tauri webview. */
export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Dev-only browser mock. Never active in the real app: gated on DEV build
// AND absence of the Tauri bridge. In production builds this folds to
// `false` and the mock is dead code.
export const USING_MOCK = import.meta.env.DEV && !IS_TAURI;

export const ipc: IpcClient = USING_MOCK ? mockClient : tauriClient;
