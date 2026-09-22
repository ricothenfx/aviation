import { cn } from "../cn";

/**
 * Live freshness cue (ui-design-system.md §7 "live-updating" state).
 * `live` = data is current; never shows a live pulse when the data source is idle (honesty).
 */
export function LiveDot({
  live,
  label,
  className,
}: {
  live: boolean;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        live ? "text-accent" : "text-muted",
        className,
      )}
      role="status"
    >
      <span aria-hidden className="relative flex h-2 w-2">
        {live ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
        ) : null}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            live ? "bg-accent" : "bg-muted",
          )}
        />
      </span>
      {label}
    </span>
  );
}
