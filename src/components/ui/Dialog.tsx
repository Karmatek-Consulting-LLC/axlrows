import * as RDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export const Dialog = RDialog.Root;
export const DialogTrigger = RDialog.Trigger;
export const DialogClose = RDialog.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  wide,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <RDialog.Portal>
      <RDialog.Overlay className="fixed inset-0 z-40 animate-fade bg-black/45 backdrop-blur-[2px] dark:bg-black/60" />
      <RDialog.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2",
          wide ? "max-w-xl" : "max-w-md",
          "animate-rise rounded-xl border border-line bg-overlay p-5 shadow-pop",
          className,
        )}
      >
        <RDialog.Title className="text-[15px] font-semibold tracking-tight">{title}</RDialog.Title>
        {description ? (
          <RDialog.Description className="mt-1 text-xs leading-relaxed text-mut">
            {description}
          </RDialog.Description>
        ) : (
          <RDialog.Description className="sr-only">{title}</RDialog.Description>
        )}
        <div className="mt-4">{children}</div>
        <RDialog.Close
          aria-label="Close"
          className="absolute top-3.5 right-3.5 rounded-md p-1 text-mut transition-colors hover:bg-raised hover:text-ink"
        >
          <X className="size-4" />
        </RDialog.Close>
      </RDialog.Content>
    </RDialog.Portal>
  );
}
