"use client";

import { useEffect, useState } from "react";

import { Button, Panel, StatusBadge } from "@aviation/ui";

/**
 * Scenario injection console (PRD F-1 demo beat, rebook-ai api-contracts.md
 * §1 POST /api/v1/scenario/inject): supervisor-only. Flight list comes from
 * the seeded reference day (server component); injection appends
 * `flight.disrupted` and the orchestrator pipeline does the rest.
 */

export interface ConsoleFlight {
  flightNo: string;
  dest: string;
  schedDep: string;
}

export function ScenarioConsole({ flights }: { flights: ConsoleFlight[] }) {
  const [selected, setSelected] = useState<string>(flights[0]?.flightNo ?? "");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function inject(scenario: "cancellation" | "long-delay"): Promise<void> {
    setBusy(true);
    setOutcome(null);
    setError(null);
    try {
      const res = await fetch("/api/v1/scenario/inject", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ scenario, flightNo: selected }),
      });
      const body = (await res.json().catch(() => null)) as {
        eventId?: string;
        affectedPnrs?: number;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        setError(body?.error?.message ?? `inject failed (HTTP ${res.status})`);
        return;
      }
      setOutcome(
        `Injected ${scenario.replace("-", " ")} on ${selected} — ${body?.affectedPnrs ?? 0} PNR(s) affected. Offers and notifications follow within seconds.`,
      );
    } catch {
      setError("network error — is the stack running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="p-0">
      <div className="border-b border-border px-4 py-2.5">
        <span className="text-xs font-medium text-fg">Scenario injection</span>
      </div>
      <div className="grid gap-3 p-4">
        <label className="grid gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-muted">
            Flight (reference day)
          </span>
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            className="h-9 rounded-md border border-border bg-raised px-2 font-mono text-xs text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            {flights.map((flight) => (
              <option key={flight.flightNo} value={flight.flightNo}>
                {flight.flightNo} SIN→{flight.dest} · {flight.schedDep.slice(11, 16)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="danger"
            disabled={busy || !selected}
            onClick={() => void inject("cancellation")}
          >
            Inject cancellation
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !selected}
            onClick={() => void inject("long-delay")}
          >
            Inject 4 h delay
          </Button>
        </div>
        {outcome && (
          <p
            className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-xs text-fg"
            role="status"
          >
            {outcome}
          </p>
        )}
        {error && (
          <p
            className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-fg"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}

export function PoisonPanel() {
  const [events, setEvents] = useState<
    { id: string; type: string; attempts: number; processError: string }[]
  >([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const load = (): void => {
      void (async () => {
        try {
          const res = await fetch("/api/v1/admin/events?processed=false");
          if (!res.ok) {
            setPhase("error");
            return;
          }
          const body = (await res.json()) as { events: typeof events };
          setEvents(body.events);
          setPhase("ready");
        } catch {
          setPhase("error");
        }
      })();
    };
    const timer = setInterval(load, 5_000);
    load();
    return () => clearInterval(timer);
  }, []);

  if (phase === "loading") {
    return (
      <Panel className="p-0">
        <div className="border-b border-border px-4 py-2.5">
          <span className="text-xs font-medium text-fg">Poison events</span>
        </div>
        <div className="px-4 py-3 text-xs text-muted">checking…</div>
      </Panel>
    );
  }

  return (
    <Panel className="p-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-xs font-medium text-fg">Poison events</span>
        <StatusBadge tone={events.length > 0 ? "danger" : "ok"}>
          {events.length > 0 ? `${events.length} failed` : "clean"}
        </StatusBadge>
      </div>
      {events.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted">
          No poison events — every appended event has been processed or is still waiting for the
          tail.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {events.map((event) => (
            <div key={event.id} className="px-4 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-fg">{event.type}</span>
                <span className="font-mono text-[10px] text-muted">attempts: {event.attempts}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-danger">{event.processError}</p>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
