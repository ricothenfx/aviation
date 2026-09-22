import type { ReactNode } from "react";

import { cn } from "../cn";

/** Surface panel — the base container for board regions (ui-design-system.md §2 surface). */
export function Panel({
  title,
  actions,
  children,
  className,
  contentClassName,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section
      className={cn("flex min-h-0 flex-col rounded-lg border border-border bg-surface", className)}
    >
      {title ? (
        <header className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className={cn("min-h-0 flex-1 p-3", contentClassName)}>{children}</div>
    </section>
  );
}
