import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-8 w-full rounded-md border border-line bg-surface px-2.5 text-[12.5px] text-ink",
        "placeholder:text-faint transition-colors",
        "hover:border-line-2 focus:border-accent/60 focus:outline-none",
        "focus:ring-2 focus:ring-accent/25",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
