import { cn } from "../../lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-3.5 animate-spin rounded-full border-[1.5px]",
        "border-current border-t-transparent",
        className,
      )}
    />
  );
}
