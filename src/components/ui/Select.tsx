import * as RSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  className,
  ariaLabel,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: readonly { value: T; label: string }[] | readonly T[];
  className?: string;
  ariaLabel?: string;
}) {
  const items = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  );
  return (
    <RSelect.Root value={value} onValueChange={(v) => onValueChange(v as T)}>
      <RSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md border",
          "border-line bg-surface px-2.5 text-[12.5px] text-ink transition-colors",
          "hover:border-line-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/25",
          className,
        )}
      >
        <RSelect.Value />
        <RSelect.Icon>
          <ChevronDown className="size-3.5 text-mut" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-72 min-w-(--radix-select-trigger-width) animate-rise overflow-y-auto rounded-md border border-line bg-overlay p-1 shadow-pop"
        >
          <RSelect.Viewport>
            {items.map((it) => (
              <RSelect.Item
                key={it.value}
                value={it.value}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-[5px] px-2 py-1.5 text-[12.5px] text-ink outline-none select-none data-[highlighted]:bg-accent/12 data-[highlighted]:text-ink"
              >
                <RSelect.ItemText>{it.label}</RSelect.ItemText>
                <RSelect.ItemIndicator>
                  <Check className="size-3.5 text-accent" />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}
