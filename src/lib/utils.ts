/** Join class names, skipping falsy values. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Human-friendly milliseconds: 843 ms, 1.24 s, 12.5 s */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Normalize an unknown rejection (backend rejects with plain strings). */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

// Distinct, theme-stable hues used to attribute rows/chips to a UCM.
const UCM_HUES = [199, 265, 32, 152, 340, 215, 48, 291, 6, 174] as const;

/** Deterministic hue for a UCM id — used for dots, chips and the origin column. */
export function ucmHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return UCM_HUES[h % UCM_HUES.length];
}
