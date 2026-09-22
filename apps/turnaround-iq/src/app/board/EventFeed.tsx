"use client";

import { EmptyState, Skeleton, StatusBadge } from "@aviation/ui";

/**
 * Live event feed (PRD F-2 audit trail, ui-design-system.md §5.1 right rail).
 * Every frame the board channel delivers lands here newest-first — the visible
 * proof that all state changes arrive as immutable events (ADR-0001).
 */

export interface FeedItem {
  id: string;
  ts: string;
  type: string;
  label: string;
}

function toneForType(type: string): "ok" | "warn" | "danger" | "info" | "muted" {
  if (type.startsWith("alert.")) return type === "alert.resolved" ? "ok" : "danger";
  if (type === "replan.proposed") return "warn";
  if (type === "turn.started" || type === "task.state_changed") return "info";
  if (type === "flight.delay_risk") return "danger";
  return "muted";
}

export function EventFeed({ items, loading }: { items: FeedItem[] | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="space-y-2" aria-label="Loading event feed">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (items === null || items.length === 0) {
    return (
      <EmptyState
        title="No events yet"
        body="Every state change arrives as an immutable event (ADR-0001). Start a scenario to watch the audit stream build."
      />
    );
  }
  return (
    <ul aria-live="polite" className="max-h-full space-y-1 overflow-y-auto">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2 font-mono text-xs">
          <span className="shrink-0 text-muted tabular-nums">{item.ts.slice(11, 19)}Z</span>
          <StatusBadge tone={toneForType(item.type)}>{item.type}</StatusBadge>
          <span className="truncate text-muted" title={item.label}>
            {item.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
