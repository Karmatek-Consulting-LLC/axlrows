import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-mut">
        {label}
        {hint}
      </span>
      {children}
    </label>
  );
}
