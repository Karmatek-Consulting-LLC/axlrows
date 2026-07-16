import { cn } from "../lib/utils";

/**
 * AXLRows mark: three data rows, the middle one "in flight" — nodding to
 * queries fanning out across the wire. Pure inline SVG; no asset files.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-5", className)} aria-hidden>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" className="fill-accent" />
      <g strokeLinecap="round" strokeWidth="2.6" className="stroke-on-accent">
        <line x1="6.2" y1="7.6" x2="17.8" y2="7.6" opacity="0.55" />
        <line x1="6.2" y1="12" x2="13.4" y2="12" />
        <line x1="6.2" y1="16.4" x2="17.8" y2="16.4" opacity="0.55" />
      </g>
      <circle cx="17.4" cy="12" r="1.7" className="fill-on-accent" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-baseline text-[14px] leading-none font-semibold tracking-tight select-none">
      <span className="text-ink">AXL</span>
      <span className="text-mut font-normal">Rows</span>
    </span>
  );
}
