import { CircleAlert, CircleCheck, CircleX, Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { useQueryStore, type TargetState } from "../stores/query";
import type { ThrottleInfo } from "../lib/types";
import { cn, fmtCount, fmtMs, ucmHue } from "../lib/utils";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/Spinner";
import { Tip } from "./ui/Tooltip";

type ThrottledTarget = TargetState & { throttle: ThrottleInfo };

/** Live per-target run progress — each UCM's state streams in as it settles. */
export function RunStatus() {
  const targets = useQueryStore((s) => s.targets);
  const running = useQueryStore((s) => s.running);

  if (targets.length === 0) return null;

  const throttled = targets.filter(
    (t): t is ThrottledTarget => t.status === "throttled" && t.throttle !== null,
  );

  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex flex-wrap gap-1.5">
        {targets.map((t) => (
          <TargetChip key={t.ucmId} target={t} runActive={running} />
        ))}
      </div>
      {throttled.map((t) => (
        <ThrottleCard key={t.ucmId} target={t} />
      ))}
    </div>
  );
}

function TargetChip({ target: t, runActive }: { target: TargetState; runActive: boolean }) {
  const hue = ucmHue(t.ucmId);
  const active = t.status === "pending" || t.status === "running";

  const chip = (
    <div
      className={cn(
        "relative flex h-7 items-center gap-1.5 overflow-hidden rounded-md border px-2 text-xs",
        "animate-rise transition-colors duration-200",
        t.status === "error"
          ? "border-err/35 bg-err/8"
          : t.status === "throttled"
            ? "border-warn/35 bg-warn/8"
            : t.status === "ok"
              ? t.rowCount === 0
                ? "border-warn/35 bg-warn/8"
                : "border-ok/30 bg-ok/8"
              : "border-line bg-surface",
      )}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: `hsl(${hue} 75% 52%)` }} />
      <span className={cn("font-medium", active ? "text-mut" : "text-ink")}>{t.ucmName}</span>

      {t.status === "pending" && <span className="text-faint">queued</span>}
      {t.status === "running" &&
        (t.batch ? (
          <span className="flex items-center gap-1 tabular-nums text-mut">
            <Spinner className="size-3 text-accent" />
            <span className="text-ink">{fmtCount(t.batch.fetched)}</span>
            <span className="text-faint">/ {fmtCount(t.batch.total)}</span>
            <span className="text-faint">
              · batch {t.batch.batchIndex} of {t.batch.batches}
            </span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-mut">
            <Spinner className="size-3 text-accent" />
            <LiveElapsed active={runActive} />
          </span>
        ))}
      {t.status === "ok" && (
        <span className="flex items-center gap-1 tabular-nums">
          {t.rowCount === 0 ? (
            <>
              <CircleAlert className="size-3.5 text-warn" />
              <span className="text-warn">no matching rows</span>
            </>
          ) : (
            <>
              <CircleCheck className="size-3.5 text-ok" />
              <span className="text-ink">{fmtCount(t.rowCount ?? 0)}</span>
              <span className="text-faint">rows</span>
            </>
          )}
          <span className="text-faint">· {fmtMs(t.elapsedMs ?? 0)}</span>
        </span>
      )}
      {t.status === "throttled" && (
        <span className="flex items-center gap-1 tabular-nums">
          <Layers className="size-3.5 text-warn" />
          <span className="text-warn">
            {t.throttle ? `${fmtCount(t.throttle.totalRows)} matched · 8 MB cap` : "8 MB cap"}
          </span>
          <span className="text-faint">· {fmtMs(t.elapsedMs ?? 0)}</span>
        </span>
      )}
      {t.status === "error" && (
        <span className="flex min-w-0 items-center gap-1">
          <CircleX className="size-3.5 shrink-0 text-err" />
          <span className="max-w-64 truncate text-err">{t.message}</span>
          <span className="text-faint">· {fmtMs(t.elapsedMs ?? 0)}</span>
        </span>
      )}

      {/* progress edge: determinate while batching, scanning shimmer otherwise */}
      {t.status === "running" && (
        <span className="absolute inset-x-0 bottom-0 h-px overflow-hidden">
          {t.batch ? (
            <span
              className="absolute inset-y-0 left-0 bg-accent transition-[width] duration-300"
              style={{ width: `${(100 * t.batch.fetched) / Math.max(1, t.batch.total)}%` }}
            />
          ) : (
            <span className="absolute h-px w-2/5 animate-scan bg-accent/80" />
          )}
        </span>
      )}
    </div>
  );

  // Full error message on hover — the chip truncates long AXL faults.
  return t.status === "error" && t.message ? (
    <Tip content={t.message} side="bottom" align="start">
      {chip}
    </Tip>
  ) : (
    chip
  );
}

/**
 * Affordance for a query UCM refused as too large. Deliberately amber, not
 * red — this is an expected, recoverable state. The row and batch counts stay
 * visible BEFORE the click: the owner chose an explicit button over silent
 * auto-pagination so a query matching millions of rows can't quietly fire
 * thousands of requests at a production UCM.
 */
function ThrottleCard({ target: t }: { target: ThrottledTarget }) {
  const th = t.throttle;
  const hue = ucmHue(t.ucmId);
  return (
    <div
      className={cn(
        "flex animate-rise flex-wrap items-center gap-x-3 gap-y-1.5",
        "rounded-lg border border-warn/35 bg-warn/8 px-3 py-2 text-xs",
      )}
    >
      <Layers className="size-4 shrink-0 text-warn" />
      <div className="min-w-0 grow basis-64">
        <span className="mr-1.5 inline-flex items-center gap-1.5 font-medium text-ink">
          <span className="size-2 rounded-full" style={{ background: `hsl(${hue} 75% 52%)` }} />
          {t.ucmName}
        </span>
        <span className="text-mut">
          UCM matched <b className="font-semibold text-ink">{fmtCount(th.totalRows)}</b> rows but
          caps responses at 8 MB.
          {th.canPaginate && <> Suggested batch: {fmtCount(th.suggestedFetch)}.</>}
        </span>
        {!th.canPaginate && (
          <div className="mt-0.5 font-medium text-warn">
            {th.reason ?? "This query can't be fetched in batches."}
          </div>
        )}
      </div>
      {th.canPaginate && (
        <Button
          variant="primary"
          size="sm"
          onClick={() => void useQueryStore.getState().fetchBatched(t.ucmId)}
        >
          Fetch all {fmtCount(th.totalRows)} in {th.batches} batch{th.batches === 1 ? "" : "es"}
        </Button>
      )}
    </div>
  );
}

/** Ticking elapsed readout for in-flight targets. */
function LiveElapsed({ active }: { active: boolean }) {
  const startedAt = useQueryStore((s) => s.runStartedAt);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [active]);
  if (!startedAt) return null;
  return <span className="tabular-nums text-faint">{fmtMs(Date.now() - startedAt)}</span>;
}
