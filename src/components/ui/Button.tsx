import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type Variant = "primary" | "default" | "ghost" | "danger-ghost";
type Size = "md" | "sm" | "icon" | "icon-sm";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-on-accent font-semibold hover:bg-accent-2 active:translate-y-px " +
    "shadow-[inset_0_1px_0_rgb(255_255_255/0.15)]",
  default:
    "bg-raised text-ink border border-line-2/60 hover:border-line-2 hover:bg-raised/70 active:translate-y-px",
  ghost: "text-mut hover:text-ink hover:bg-raised",
  "danger-ghost": "text-mut hover:text-err hover:bg-err/10",
};

const sizes: Record<Size, string> = {
  md: "h-8 px-3.5 gap-1.5 text-[12.5px]",
  sm: "h-7 px-2.5 gap-1.5 text-xs",
  icon: "h-8 w-8",
  "icon-sm": "h-7 w-7",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "default", size = "md", className, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md font-medium",
        "transition-colors duration-100 select-none",
        "disabled:pointer-events-none disabled:opacity-45",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
