"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, EmptyState, ErrorState, LiveDot, Panel, Skeleton } from "@aviation/ui";

/**
 * Agent queue panel (PRD F-4 surface). F1: renders the real /api/v1/queue
 * contract with all mandatory states (ui-design-system.md §7). F2 fills the
 * queue rows and wires the live Redis projection.
 */

interface QueueSnapshot {
  items: never[];
  containmentPct: number | null;
  generatedAt: string;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; data: QueueSnapshot; fetchedAt: number }
  | { phase: "error"; message: string };

export function QueuePanel() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/queue");
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setState({
          phase: "error",
          message: body?.error?.message ?? `queue unavailable (HTTP ${res.status})`,
        });
        return;
      }
      const data = (await res.json()) as QueueSnapshot;
      setState({ phase: "ready", data, fetchedAt: Date.now() });
    } catch {
      setState({ phase: "error", message: "network error — is the stack running?" });
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 15_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  if (state.phase === "loading") {
    return (
      <Panel>
        <div className="border-b border-border px-4 py-2.5">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="space-y-2 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      </Panel>
    );
  }

  if (state.phase === "error") {
    return (
      <Panel className="p-0">
        <ErrorState
          title="Queue unavailable"
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
  const containment =
    state.data.containmentPct === null ? "—" : `${state.data.containmentPct.toFixed(0)}%`;

  return (
    <div className="grid gap-4">
      <Panel>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-fg">Queue</span>
            <LiveDot live label="live" />
          </div>
          <span className="font-mono text-[11px] text-muted" aria-live="polite">
            updated {ageSeconds}s ago
          </span>
        </div>
        <EmptyState
          title="Queue clear"
          body="No disrupted passengers are waiting for agent assistance. When a disruption is injected, affected PNRs appear here ranked by tier and SLA."
        />
      </Panel>

      <div className="grid gap-4 md:grid-cols-3">
        <Panel className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Waiting</div>
          <div className="mt-1 font-mono text-xl text-fg">0</div>
        </Panel>
        <Panel className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            Self-serve containment
          </div>
          <div className="mt-1 font-mono text-xl text-fg">{containment}</div>
        </Panel>
        <Panel className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Open proposals</div>
          <div className="mt-1 font-mono text-xl text-fg">0</div>
        </Panel>
      </div>
    </div>
  );
}
