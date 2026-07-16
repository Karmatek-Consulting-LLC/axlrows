// Domain types — mirrors CONTRACT.md exactly. Do not deviate.

export const AXL_VERSIONS = [
  "7.0",
  "7.1",
  "8.0",
  "8.5",
  "9.0",
  "9.1",
  "10.0",
  "10.5",
  "11.0",
  "11.5",
  "12.0",
  "12.5",
  "14.0",
  "15.0",
] as const;

export type AxlVersion = (typeof AXL_VERSIONS)[number];

export const DEFAULT_AXL_VERSION: AxlVersion = "15.0";

export interface Ucm {
  id: string; // uuid v4
  name: string;
  host: string; // hostname or IP, no scheme, no port
  username: string;
  version: AxlVersion;
  verifyTls: boolean; // false = accept self-signed (lab default)
  hasPassword: boolean; // true if a secret exists in the OS keychain
  createdAt: string; // RFC3339
}

export interface UcmInput {
  name: string;
  host: string;
  username: string;
  password?: string | null; // null/undefined on update = leave keychain entry untouched
  version: AxlVersion;
  verifyTls: boolean;
}

export interface Favorite {
  id: string; // uuid v4
  name: string; // user label; default "Untitled query"
  sql: string;
  createdAt: string; // RFC3339
  updatedAt: string; // RFC3339
}

// A result row is a flat string map. Every value is stringified; null -> "".
export type Row = Record<string, string>;

export interface TestUcmResult {
  ok: boolean;
  message: string;
  elapsedMs: number;
}

// ---- Event payloads (CONTRACT.md `query://*` events) ----

export interface TargetStartedPayload {
  runId: string;
  ucmId: string;
  ucmName: string;
}

export interface TargetSuccessPayload {
  runId: string;
  ucmId: string;
  ucmName: string;
  columns: string[];
  rows: Row[];
  elapsedMs: number;
}

export interface TargetErrorPayload {
  runId: string;
  ucmId: string;
  ucmName: string;
  message: string;
  elapsedMs: number;
}

export interface QueryCompletePayload {
  runId: string;
  okCount: number;
  errCount: number;
  throttledCount: number;
  totalRows: number;
}

// ---- UCM 8 MB throttle handling (CONTRACT-THROTTLE.md) ----

export interface ThrottleInfo {
  totalRows: number; // "Total rows matched: N"
  suggestedFetch: number; // "Suggested row fetch: less than M" (M itself)
  batchSize: number; // what AXLRows will actually use; <= suggestedFetch - 1
  batches: number; // ceil(totalRows / batchSize)
  canPaginate: boolean; // false => the SQL can't be safely rewritten
  reason?: string; // present iff canPaginate === false; user-facing
}

export interface TargetThrottledPayload {
  runId: string;
  ucmId: string;
  ucmName: string;
  elapsedMs: number;
  throttle: ThrottleInfo;
}

export interface TargetBatchProgressPayload {
  runId: string;
  ucmId: string;
  ucmName: string;
  batchIndex: number; // 1-based
  batches: number;
  fetched: number;
  total: number;
}
