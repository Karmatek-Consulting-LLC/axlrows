import { Check, Server } from "lucide-react";
import { useQueryStore } from "../stores/query";
import { useUcmsStore } from "../stores/ucms";
import { useUiStore } from "../stores/ui";
import { cn, ucmHue } from "../lib/utils";

/**
 * Multi-select as a row of toggle pills — every server visible at a glance,
 * one click to include/exclude, color-keyed to match result attribution.
 */
export function TargetPicker() {
  const ucms = useUcmsStore((s) => s.ucms);
  const targetIds = useQueryStore((s) => s.targetIds);
  const toggleTarget = useQueryStore((s) => s.toggleTarget);
  const setTargetIds = useQueryStore((s) => s.setTargetIds);
  const setView = useUiStore((s) => s.setView);

  if (ucms.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-mut">
        <Server className="size-3.5 text-faint" />
        No UCM servers yet.
        <button
          className="cursor-pointer font-medium text-accent hover:underline"
          onClick={() => setView("servers")}
        >
          Add one →
        </button>
      </div>
    );
  }

  const allSelected = targetIds.length === ucms.length;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] font-semibold tracking-wider text-faint uppercase select-none">
        Targets
      </span>
      {ucms.map((u) => {
        const selected = targetIds.includes(u.id);
        const hue = ucmHue(u.id);
        return (
          <button
            key={u.id}
            type="button"
            role="checkbox"
            aria-checked={selected}
            onClick={() => toggleTarget(u.id)}
            className={cn(
              "group flex h-7 cursor-pointer items-center gap-1.5 rounded-full border pr-2.5 pl-2 text-xs",
              "transition-all duration-100 select-none",
              selected
                ? "border-accent/45 bg-accent/12 text-ink"
                : "border-line bg-surface text-mut hover:border-line-2 hover:text-ink",
            )}
            title={`${u.host} · AXL ${u.version}`}
          >
            <span
              className="size-2 rounded-full"
              style={{
                background: `hsl(${hue} 75% ${selected ? "55%" : "40%"})`,
                opacity: selected ? 1 : 0.55,
              }}
            />
            <span className="font-medium">{u.name}</span>
            <Check
              className={cn(
                "size-3 text-accent transition-all",
                selected ? "opacity-100" : "-ml-1 w-0 opacity-0",
              )}
            />
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => setTargetIds(allSelected ? [] : ucms.map((u) => u.id))}
        className="ml-0.5 cursor-pointer rounded-md px-1.5 py-1 text-[11px] font-medium text-faint transition-colors hover:bg-raised hover:text-ink"
      >
        {allSelected ? "None" : "All"}
      </button>
    </div>
  );
}
