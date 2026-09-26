"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, EmptyState, ErrorState, LiveDot, Panel, Skeleton, StatTile } from "@aviation/ui";

/**
 * Passenger trip panel (PRD F-1/F-2 surface). F1: renders the real
 * /api/v1/pax/summary contract with all mandatory states (ui-design-system.md
 * §7) — loading skeleton, honest "no active disruption" empty state, error +
 * retry, and a live freshness cue from polling. F2 fills the offer cards.
 */

interface PaxSummary {
  disruption: null;
  offers: never[];
  vouchers: never[];
  notifications: never[];
  passenger: { email: string; name: string };
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; data: PaxSummary; fetchedAt: number }
  | { phase: "error"; message: string };

export function TripPanel() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/pax/summary");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setState({
          phase: "error",
          message: body?.error?.message ?? `summary unavailable (HTTP ${res.status})`,
        });
        return;
      }
      const data = (await res.json()) as PaxSummary;
      setState({ phase: "ready", data, fetchedAt: Date.now() });
    } catch {
      setState({ phase: "error", message: "network error — is the stack running?" });
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 30_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  if (state.phase === "loading") {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-24 md:col-span-2" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64 md:col-span-3" />
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <Panel className="p-0">
        <ErrorState
          title="Trip summary unavailable"
          message={state.message}
          action={
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      </Panel>
    );
  }

  const ageSeconds = Math.max(0, Math.round((now - state.fetchedAt) / 1000));

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <StatTile label="Active disruption" value="None" hint="No IROP on your bookings" />
        <StatTile
          label="Rebooking offers"
          value="0"
          hint="Offers appear within seconds of a disruption"
        />
        <StatTile label="Vouchers" value="0" hint="Issued automatically when criteria are met" />
      </div>

      <Panel>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <LiveDot live label="live" />
          <span className="font-mono text-[11px] text-muted" aria-live="polite">
            updated {ageSeconds}s ago
          </span>
        </div>
        <div className="px-4 py-2">
          <span className="text-xs font-medium text-fg">Notifications</span>
        </div>
        <EmptyState
          title="No active disruption"
          body="If your flight is disrupted, ranked rebooking options and any automatic voucher appear here within seconds — before you reach the counter."
        />
      </Panel>
    </div>
  );
}
