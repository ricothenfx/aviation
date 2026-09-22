import { cn } from "../cn";

export type StatusTone = "ok" | "warn" | "danger" | "info" | "muted";

const TONE_CLASSES: Record<StatusTone, string> = {
  ok: "text-ok border-ok/40",
  warn: "text-warn border-warn/40",
  danger: "text-danger border-danger/40",
  info: "text-accent border-accent/40",
  muted: "text-muted border-border",
};

const DOT_CLASSES: Record<StatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-accent",
  muted: "bg-muted",
};

/**
 * Status chip. Color never encodes information alone (ui-design-system.md §2):
 * the label is mandatory, the dot is redundant reinforcement.
 */
export function StatusBadge({
  tone = "muted",
  children,
  className,
}: {
  tone?: StatusTone;
  children: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASSES[tone])} />
      {children}
    </span>
  );
}
