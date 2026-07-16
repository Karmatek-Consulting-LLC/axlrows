import * as RTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export const TooltipProvider = RTooltip.Provider;

export function Tip({
  content,
  children,
  side = "top",
  align = "center",
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-72 animate-fade rounded-md border border-line bg-overlay px-2.5 py-1.5 text-xs leading-relaxed text-ink shadow-pop"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
