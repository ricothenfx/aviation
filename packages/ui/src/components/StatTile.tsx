import { cn } from "../cn";

/**
 * KPI tile with tabular numerals (ui-design-system.md §3: tabular numerals for metrics).
 * `value` may be a string ("—") when data is not yet available — never fake numbers.
 */
export function StatTile({
  label,
  value,
  hint,
  className,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
  /** Stable hook for e2e tests (optional; additive F4). */
  testId?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-surface px-4 py-3", className)}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 font-mono text-2xl leading-7 tabular-nums text-fg" data-testid={testId}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}
