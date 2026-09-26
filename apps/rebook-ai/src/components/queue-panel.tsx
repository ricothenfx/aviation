"use client";

import { useCallback, useEffect, useState } from "react";

import {
  Button,
  EmptyState,
  ErrorState,
  LiveDot,
  Panel,
  Skeleton,
  StatusBadge,
} from "@aviation/ui";
import { ProposalPanel } from "@/components/proposal-panel";
import type { PnrDetailView, QueueSnapshotView } from "@aviation/contracts";

/**
 * Agent queue console v1 (PRD F-4): live priority-sorted queue that shrinks
 * as passengers self-serve, containment tile, expandable PNR context per row.
 * Live via SSE (`queue.delta` — agent+ streams) + 15 s poll fallback.
 */

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; data: QueueSnapshotView; fetchedAt: number }
  | { phase: "error"; message: string };

export function QueuePanel() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, PnrDetailView | "loading" | null>>({});
  const [reloadKey, setReloadKey] = useState(0);
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
      const data = (await res.json()) as QueueSnapshotView;
      setState({ phase: "ready", data, fetchedAt: Date.now() });
    } catch {
      setState({ phase: "error", message: "network error — is the stack running?" });
    }
  }, []);

  const refreshExpanded = useCallback(async (locator: string) => {
    try {
      const res = await fetch(`/api/v1/pnr/${locator}`);
      const body = res.ok ? ((await res.json()) as PnrDetailView) : null;
      setDetail((prev) => ({ ...prev, [locator]: body }));
    } catch {
      setDetail((prev) => ({ ...prev, [locator]: null }));
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 15_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const source = new EventSource("/api/v1/live");
    source.onmessage = () => {
      void load();
      setReloadKey((key) => key + 1); // saga/proposal frames: refresh expanded rows
    };
    source.onerror = () => source.close();
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      source.close();
    };
  }, [load]);

  async function togglePnr(locator: string): Promise<void> {
    if (expanded === locator) {
      setExpanded(null);
      return;
    }
    setExpanded(locator);
    if (!detail[locator] || detail[locator] === null) {
      setDetail((prev) => ({ ...prev, [locator]: "loading" }));
      try {
        const res = await fetch(`/api/v1/pnr/${locator}`);
        const body = res.ok ? ((await res.json()) as PnrDetailView) : null;
        setDetail((prev) => ({ ...prev, [locator]: body }));
      } catch {
        setDetail((prev) => ({ ...prev, [locator]: null }));
      }
    }
  }

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

  const { data } = state;
  const ageSeconds = Math.max(0, Math.round((now - state.fetchedAt) / 1000));
  const containment = data.containmentPct === null ? "—" : `${data.containmentPct}%`;

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Panel className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Waiting</div>
          <div className="mt-1 font-mono text-xl text-fg" data-testid="queue-waiting">
            {data.waiting}
          </div>
        </Panel>
        <Panel className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">
            Self-serve containment
          </div>
          <div className="mt-1 font-mono text-xl text-fg" data-testid="queue-containment">
            {containment}
          </div>
        </Panel>
        <Panel className="px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Open proposals</div>
          <div className="mt-1 font-mono text-xl text-fg" data-testid="queue-open-proposals">
            {data.openProposals}
          </div>
          <div className="mt-0.5 text-[10px] text-muted">awaiting agent decision</div>
        </Panel>
      </div>

      <Panel className="p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-fg">Queue</span>
            <LiveDot live label="live" />
          </div>
          <span className="font-mono text-[11px] text-muted" aria-live="polite">
            updated {ageSeconds}s ago
          </span>
        </div>

        {data.items.length === 0 ? (
          <EmptyState
            title="Queue clear"
            body="No disrupted passengers are waiting for agent assistance. When a disruption is injected, affected PNRs appear here ranked by tier and SLA."
          />
        ) : (
          <div className="divide-y divide-border">
            <div className="grid grid-cols-[7rem_1fr_5rem_6rem_4.5rem_5rem] gap-2 px-4 py-2 text-[10px] uppercase tracking-wide text-muted">
              <span>Locator</span>
              <span>Passenger</span>
              <span>Tier</span>
              <span>Flight</span>
              <span>Wait</span>
              <span>Offer</span>
            </div>
            {data.items.map((item) => (
              <div key={item.pnrId} data-testid={`queue-row-${item.locator}`}>
                <button
                  type="button"
                  onClick={() => void togglePnr(item.locator)}
                  className="grid w-full grid-cols-[7rem_1fr_5rem_6rem_4.5rem_5rem] items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span className="font-mono text-xs font-semibold text-fg">{item.locator}</span>
                  <span className="truncate text-xs text-fg">
                    {item.passengerName}
                    {item.partySize > 1 && <span className="text-muted"> ×{item.partySize}</span>}
                  </span>
                  <span>
                    <StatusBadge
                      tone={
                        item.tier === "gold" ? "warn" : item.tier === "silver" ? "info" : "muted"
                      }
                    >
                      {item.tier}
                    </StatusBadge>
                  </span>
                  <span className="font-mono text-xs text-muted">{item.flightNo}</span>
                  <span className="font-mono text-xs text-muted">{item.waitMinutes}m</span>
                  <span className="font-mono text-[10px] text-muted">{item.offerState ?? "—"}</span>
                </button>
                {expanded === item.locator && (
                  <div className="border-t border-border bg-raised/30 px-4 py-3">
                    {detail[item.locator] === "loading" && <Skeleton className="h-12 w-full" />}
                    {detail[item.locator] === null && (
                      <p className="text-xs text-danger">Booking context unavailable right now.</p>
                    )}
                    {detail[item.locator] && detail[item.locator] !== "loading" && (
                      <div className="grid gap-3">
                        <PnrSummary detail={detail[item.locator] as PnrDetailView} />
                        <ProposalPanel
                          key={`${item.locator}-${reloadKey}`}
                          locator={item.locator}
                          proposals={(detail[item.locator] as PnrDetailView).proposals}
                          onChanged={() => void refreshExpanded(item.locator)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function PnrSummary({ detail }: { detail: PnrDetailView }) {
  return (
    <div className="grid gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted">
        <span className="font-medium text-fg">{detail.passengerName}</span>
        <span>{detail.tier} tier</span>
        <span>fare {detail.fareClass}</span>
        <span className="font-mono">{detail.contactHandle}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {detail.segments.map((segment) => (
          <span
            key={`${segment.flightNo}-${segment.flightDate}`}
            className="rounded-md border border-border px-2 py-1 font-mono text-[10px] text-muted"
          >
            {segment.flightNo} {segment.origin}→{segment.dest} · {segment.status}
          </span>
        ))}
      </div>
      {detail.disruption && (
        <p className="text-[11px] text-muted">
          Disruption: {detail.disruption.flightNo}{" "}
          {detail.disruption.kind === "cancellation"
            ? "cancelled"
            : `delayed ${detail.disruption.delayMinutes ?? 0} min`}{" "}
          ({detail.disruption.reasonCode})
        </p>
      )}
      {detail.offers.length > 0 && (
        <p className="text-[11px] text-muted">
          Latest offer: {detail.offers[0]?.state} · {detail.offers[0]?.options.length} options
        </p>
      )}
    </div>
  );
}
