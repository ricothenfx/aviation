import type { ReactNode } from "react";

import { cn } from "../cn";

/**
 * Error state: explain what failed + retry, preserving user input (ui-design-system.md §7).
 * Passing the request id supports support/audit workflows.
 */
export function ErrorState({
  title = "Something went wrong",
  message,
  requestId,
  action,
  className,
}: {
  title?: string;
  message: string;
  requestId?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-2 rounded-lg px-6 py-10 text-center",
        className,
      )}
      data-testid="error-state"
      role="alert"
    >
      <div className="text-sm font-medium text-danger">{title}</div>
      <p className="max-w-sm text-xs leading-5 text-muted">{message}</p>
      {requestId ? (
        <div className="font-mono text-[10px] text-muted/80">request {requestId}</div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
