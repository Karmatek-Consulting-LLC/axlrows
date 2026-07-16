import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { useEffect, useState } from "react";
import { useQueryStore, type TargetState } from "../stores/query";
import { cn, fmtCount, fmtMs, ucmHue } from "../lib/utils";
import { Spinner } from "./ui/Spinner";
import { Tip } from "./ui/Tooltip";

/** Live per-target run progress — each UCM's state streams in as it settles. */
export function RunStatus() {
  const targets = useQueryStore((s) => s.targets);
  const running = useQueryStore((s) => s.running);

  if (targets.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5" aria-live="polite">
      {targets.map((t) => (
        <TargetChip key={t.ucmId} target={t} runActive={running} />
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
      {t.status === "running" && (
        <span className="flex items-center gap-1.5 text-mut">
          <Spinner className="size-3 text-accent" />
          <LiveElapsed active={runActive} />
        </span>
      )}
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
      {t.status === "error" && (
        <span className="flex min-w-0 items-center gap-1">
          <CircleX className="size-3.5 shrink-0 text-err" />
          <span className="max-w-64 truncate text-err">{t.message}</span>
          <span className="text-faint">· {fmtMs(t.elapsedMs ?? 0)}</span>
        </span>
      )}

      {/* scanning shimmer while in flight */}
      {t.status === "running" && (
        <span className="absolute inset-x-0 bottom-0 h-px overflow-hidden">
          <span className="absolute h-px w-2/5 animate-scan bg-accent/80" />
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
