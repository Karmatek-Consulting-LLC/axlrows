import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export const IS_MAC = /mac/i.test(
  (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform,
);

/** Platform modifier label: ⌘ on macOS, Ctrl elsewhere. */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[4px]",
        "border border-line-2/70 bg-raised px-1 font-sans text-[10px] font-medium text-mut",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
