"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  cursorPageSchema,
  domainEventSchema,
  flightDetailSchema,
  replanExplanationSchema,
  replanSchema,
  type FlightDetail,
  type FlightProjection,
  type Replan,
  type ReplanExplanation,
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
  userRole,
  onClose,
}: {
  flight: FlightProjection;
  scenarioTs: string | null;
  userRole: string;
  onClose: () => void;
}) {
  const [alerts, setAlerts] = useState<FlightDetail["alerts"] | null>(null);
  const [events, setEvents] = useState<{ id: string; type: string; occurredAt: string }[] | null>(
    null,
  );
  const [eventsError, setEventsError] = useState(false);
  const canReplan = userRole !== "viewer";
  const drawerRef = useRef<HTMLElement | null>(null);

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

  // Keyboard nav (ui-design-system.md §9): focus lands in the drawer on open
  // and returns to the trigger when it closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const tasks = [...flight.tasks].sort(
    (a, b) => TASK_ORDER.indexOf(a.type) - TASK_ORDER.indexOf(b.type),
  );

  return (
    <aside
      ref={drawerRef}
      role="dialog"
      aria-modal="false"
      aria-label={`Flight ${flight.flightNo} details`}
      tabIndex={-1}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] flex-col border-l border-border bg-raised shadow-xl outline-none"
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
                  {alert.leadTimeMin !== null ? (
                    <span className="text-muted">+{alert.leadTimeMin} min lead</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="No active alerts"
              body="Risk rules raise alerts ≥ 10 min before projected SLA breaches (PRD F-3)."
            />
          )}
        </section>

        {canReplan ? (
          <ReplanPanel flightId={flight.id} onApplied={() => void loadHistory()} />
        ) : null}
      </div>
    </aside>
  );
}

/**
 * One-click replan (PRD F-4, human-in-the-loop): propose via the constraint
 * engine, show the delta + honest delay math, then the copilot explanation
 * (F4, ADR-0003) labeled by source — `llm` via the gateway, `rules` after
 * graceful degradation. Approve/reject stays human.
 */
function ReplanPanel({ flightId, onApplied }: { flightId: string; onApplied: () => void }) {
  const [replan, setReplan] = useState<Replan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<ReplanExplanation | null>(null);
  const [explanationState, setExplanationState] = useState<"idle" | "loading" | "error">("idle");

  const loadExplanation = useCallback(async (replanId: string) => {
    setExplanationState("loading");
    setExplanation(null);
    try {
      const res = await fetch(`/api/v1/replans/${replanId}/explanation`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setExplanation(replanExplanationSchema.parse(await res.json()));
      setExplanationState("idle");
    } catch {
      setExplanationState("error");
    }
  }, []);

  async function propose() {
    setBusy(true);
    setError(null);
    setReplan(null);
    setExplanation(null);
    setExplanationState("idle");
    try {
      const res = await fetch(`/api/v1/flights/${flightId}/replan`, { method: "POST" });
      const body: unknown = await res.json();
      if (!res.ok) {
        const err =
          body && typeof body === "object" && "error" in body
            ? (body as { error: { code: string; message: string } }).error
            : null;
        setError(err ? `${err.code}: ${err.message}` : `HTTP ${res.status}`);
        return;
      }
      const parsed = replanSchema.parse((body as { replan: unknown }).replan);
      setReplan(parsed);
      // Every proposal gets its explanation (F4 DoD) — fetched automatically.
      void loadExplanation(parsed.id);
    } catch {
      setError("replan request failed");
    } finally {
      setBusy(false);
    }
  }

  async function decide(kind: "approve" | "reject") {
    if (!replan) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/replans/${replan.id}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:
          kind === "approve" ? undefined : JSON.stringify({ reason: "rejected from board drawer" }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const err =
          body && typeof body === "object" && "error" in body
            ? (body as { error: { message: string } }).error
            : null;
        setError(err?.message ?? `HTTP ${res.status}`);
        return;
      }
      setReplan({ ...replan, status: kind === "approve" ? "approved" : "rejected" });
      onApplied();
    } catch {
      setError("decision request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Replan">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Replan (constraint engine)
        </h3>
        {replan === null || replan.status !== "proposed" ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void propose()}>
            Propose plan
          </Button>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-surface px-2.5 py-2 text-xs text-danger"
        >
          {error}
        </p>
      ) : null}
      {replan === null ? (
        <p className="text-xs text-muted">
          Re-sequences remaining tasks under dependencies, unit availability, fueling/boarding
          safety and the stand deadline. Nothing applies without your approval.
        </p>
      ) : (
        <div className="space-y-2 rounded-md border border-border bg-surface px-2.5 py-2">
          <div className="flex items-center gap-2">
            <StatusBadge
              tone={
                replan.status === "approved"
                  ? "ok"
                  : replan.status === "rejected"
                    ? "muted"
                    : "warn"
              }
            >
              {replan.status}
            </StatusBadge>
            <span className="font-mono text-xs text-fg">{replan.totalDelayMin} min delay</span>
            {replan.baselineDelayMin !== null && replan.baselineDelayMin >= 0 ? (
              <span className="text-xs text-muted">vs {replan.baselineDelayMin} unmanaged</span>
            ) : null}
            <span className="ml-auto text-[11px] text-muted">
              {replan.delta.length} task{replan.delta.length === 1 ? "" : "s"} moved
            </span>
          </div>
          <p className="text-xs text-muted">{replan.rationale}</p>
          <ul className="space-y-0.5 font-mono text-[11px] text-fg">
            {replan.delta.map((item) => (
              <li key={item.taskId}>
                move {item.taskId.slice(0, 8)} → {item.newStart.slice(11, 16)}–
                {item.newEnd.slice(11, 16)}Z
              </li>
            ))}
          </ul>
          <CopilotExplanation
            state={explanationState}
            explanation={explanation}
            onRetry={() => void loadExplanation(replan.id)}
          />
          {replan.status === "proposed" ? (
            <div className="flex gap-2 pt-1">
              <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>
                Approve
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void decide("reject")}
              >
                Reject
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * Copilot explanation block (F4, ADR-0003): the schedule authority stays the
 * constraint engine — this narrates it. The `source` badge is honesty, not
 * decoration: `copilot · <provider>` vs the explicit rules-engine fallback.
 */
function CopilotExplanation({
  state,
  explanation,
  onRetry,
}: {
  state: "idle" | "loading" | "error";
  explanation: ReplanExplanation | null;
  onRetry: () => void;
}) {
  return (
    <div
      className="rounded-md border border-border bg-raised px-2.5 py-2"
      aria-label="Copilot explanation"
    >
      <div className="flex items-center gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Copilot explanation
        </h4>
        {explanation ? (
          <StatusBadge tone={explanation.source === "llm" ? "info" : "muted"}>
            {explanation.source === "llm"
              ? `copilot · ${explanation.provider ?? "llm"}`
              : "rules engine"}
          </StatusBadge>
        ) : null}
      </div>
      {state === "loading" ? (
        <div className="mt-1.5 space-y-1.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-5/6" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      ) : state === "error" ? (
        <div className="mt-1.5 space-y-1.5">
          <p role="alert" className="text-xs text-danger">
            The explanation request failed — the plan itself is unaffected.
          </p>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Retry explanation
          </Button>
        </div>
      ) : explanation ? (
        <>
          <p className="mt-1.5 text-xs text-fg">{explanation.text}</p>
          {explanation.source === "rules" ? (
            <p className="mt-1 text-[11px] text-muted">
              No LLM provider configured — the rule-based rationale answers instead (ADR-0003).
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
