import { cn } from "../../lib/utils";

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full transition-colors duration-150",
        checked ? "bg-accent" : "bg-line-2",
        disabled && "pointer-events-none opacity-45",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] left-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm",
          "transition-transform duration-150",
          checked && "translate-x-[14px]",
        )}
      />
    </button>
  );
}
