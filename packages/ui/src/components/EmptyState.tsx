import type { ReactNode } from "react";

import { cn } from "../cn";

/**
 * Empty state: explain what is missing + offer the first action (ui-design-system.md §7).
 */
export function EmptyState({
  title,
  body,
  action,
  icon,
  className,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-2 rounded-lg px-6 py-10 text-center",
        className,
      )}
      data-testid="empty-state"
    >
      {icon ? (
        <div aria-hidden className="mb-1 text-muted">
          {icon}
        </div>
      ) : null}
      <div className="text-sm font-medium text-fg">{title}</div>
      <p className="max-w-sm text-xs leading-5 text-muted">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
