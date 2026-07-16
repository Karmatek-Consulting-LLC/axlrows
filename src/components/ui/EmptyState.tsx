import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="mb-1 flex size-11 items-center justify-center rounded-xl border border-line bg-raised/60">
        <Icon className="size-5 text-faint" />
      </div>
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {children && <div className="max-w-sm text-xs leading-relaxed text-mut">{children}</div>}
    </div>
  );
}
