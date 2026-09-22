import { cn } from "../cn";

/** Loading placeholder that mirrors the final layout (ui-design-system.md §7). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-md bg-raised/70", className)}
      data-testid="skeleton"
    />
  );
}
