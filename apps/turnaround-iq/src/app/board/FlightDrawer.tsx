"use client";

import { useCallback, useEffect, useState } from "react";

import {
  cursorPageSchema,
  domainEventSchema,
  flightDetailSchema,
  type FlightDetail,
  type FlightProjection,
} from "@aviation/contracts";
import { Button, EmptyState, Skeleton, StatusBadge } from "@aviation/ui";

import { slaRemainingMin } from "@/lib/board/live-merge";

/**
 * Flight drawer (PRD F-2, ui-design-system.md §5.2): header → task checklist with
 * SLA countdowns → event history (audit) → alerts rail. Live task states arrive
 * via the merged board snapshot; history is fetched once per open (catch-up for
 * anything older than the live feed window).
 */

const TASK_ORDER = [
  "alighting",
  "baggage_unload",
  "cleaning",
  "lavatory_service",
  "water_service",
  "catering",
  "fueling",
  "baggage_load",
  "cabin_check",
  "document_check",
  "boarding",
  "pushback",
];

function taskStateTone(
  state: FlightProjection["tasks"][number]["state"],
): "ok" | "info" | "warn" | "muted" {
  switch (state) {
    case "done":
      return "ok";
    case "in_progress":
      return "info";
    case "blocked":
      return "warn";
    default:
      return "muted";
  }
}

function fmtTime(iso: string): string {
  return iso.slice(11, 19);
}

export function FlightDrawer({
  flight,
  scenarioTs,
  onClose,
}: {
  flight: FlightProjection;
  scenarioTs: string | null;
  onClose: () => void;
}) {
  const [alerts, setAlerts] = useState<FlightDetail["alerts"] | null>(null);
  const [events, setEvents] = useState<{ id: string; type: string; occurredAt: string }[] | null>(
    null,
  );
  const [eventsError, setEventsError] = useState(false);

  const loadHistory = useCallback(async () => {
    setEventsError(false);
    try {
      const res = await fetch(`/api/v1/flights/${flight.id}/events`);
      if (!res.ok) throw new Error(String(res.status));
      const parsed = cursorPageSchema(domainEventSchema).parse(await res.json());
      setEvents(parsed.items.map((e) => ({ id: e.id, type: e.type, occurredAt: e.occurredAt })));
    } catch {
      setEventsError(true);
    }
  }, [flight.id]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/flights/${flight.id}`);
        if (!res.ok) throw new Error(String(res.status));
        const parsed = flightDetailSchema.parse(await res.json());
        if (!disposed) setAlerts(parsed.alerts);
      } catch {
        if (!disposed) setAlerts([]);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [flight.id]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tasks = [...flight.tasks].sort(
    (a, b) => TASK_ORDER.indexOf(a.type) - TASK_ORDER.indexOf(b.type),
  );

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={`Flight ${flight.flightNo} details`}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] flex-col border-l border-border bg-raised shadow-xl"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-base font-semibold text-fg">{flight.flightNo}</h2>
            <StatusBadge
              tone={
                flight.status === "off_block"
                  ? "ok"
                  : flight.status === "delayed"
                    ? "danger"
                    : flight.status === "scheduled"
                      ? "muted"
                      : "info"
              }
            >
              {flight.status.replace("_", " ")}
            </StatusBadge>
            {flight.delayedMin > 0 ? (
              <StatusBadge tone="danger">{`+${flight.delayedMin} min`}</StatusBadge>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted">
            Stand {flight.standCode} · {flight.aircraftTypeCode} · in-block{" "}
            {fmtTime(flight.schedInBlock)}Z · off-block {fmtTime(flight.schedOffBlock)}Z
          </p>
          {flight.estOffBlock && flight.delayedMin > 0 ? (
            <p className="mt-0.5 text-xs text-warn">
              Projected off-block {fmtTime(flight.estOffBlock)}Z
            </p>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close flight drawer">
          ✕
        </Button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <section aria-label="Ground task checklist">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Ground tasks · SLA countdown
          </h3>
          <ol className="space-y-1.5">
            {tasks.map((task, index) => {
              const remaining = slaRemainingMin(task, scenarioTs);
              const breached = remaining !== null && remaining === 0 && task.state !== "done";
              return (
                <li
                  key={task.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="w-5 text-right font-mono text-[11px] text-muted">
                      {index + 1}
                    </span>
                    <StatusBadge tone={taskStateTone(task.state)}>
                      {task.state.replace("_", " ")}
                    </StatusBadge>
                    <span className="truncate font-mono text-xs text-fg">{task.type}</span>
                  </div>
                  <span
                    className={`font-mono text-xs tabular-nums ${breached ? "text-danger" : "text-muted"}`}
                    title={`SLA ${task.slaMinutes} min · window ${fmtTime(task.plannedStart)}–${fmtTime(task.plannedEnd)}Z`}
                  >
                    {task.state === "done"
                      ? `done ${fmtTime(task.plannedEnd)}Z`
                      : remaining !== null
                        ? `${breached ? "SLA 0" : `${remaining}m`}`
                        : `SLA ${task.slaMinutes}m`}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-label="Event history">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Event history
            </h3>
            <Button variant="ghost" size="sm" onClick={() => void loadHistory()}>
              Refresh
            </Button>
          </div>
          {eventsError ? (
            <EmptyState
              title="History unavailable"
              body="The event replay request failed. Retry — the audit log is immutable, nothing is lost."
            />
          ) : events === null ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : events.length === 0 ? (
            <EmptyState
              title="No events yet"
              body="This turn has not started. Events appear here the moment the simulator reaches its in-block time."
            />
          ) : (
            <ul className="space-y-1">
              {events.map((event) => (
                <li key={event.id} className="flex items-center gap-2 font-mono text-xs">
                  <span className="text-muted tabular-nums">{fmtTime(event.occurredAt)}Z</span>
                  <span className="text-fg">{event.type}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Alerts">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Alerts</h3>
          {alerts && alerts.length > 0 ? (
            <ul className="space-y-1">
              {alerts.map((alert) => (
                <li key={alert.id} className="flex items-center gap-2 text-xs">
                  <StatusBadge
                    tone={
                      alert.severity === "critical"
                        ? "danger"
                        : alert.severity === "warning"
                          ? "warn"
                          : "info"
                    }
                  >
                    {alert.state}
                  </StatusBadge>
                  <span className="font-mono text-fg">{alert.ruleId}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No active alerts"
              body="Risk rules raise alerts ≥ 10 min before projected SLA breaches — arriving with F3."
            />
          )}
        </section>
      </div>
    </aside>
  );
}
