"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  Button,
  EmptyState,
  ErrorState,
  LiveDot,
  Panel,
  Skeleton,
  StatTile,
  StatusBadge,
  useCountUp,
} from "@aviation/ui";
import { ProposalPanel } from "@/components/proposal-panel";
import type { PnrDetailView, QueueSnapshotView } from "@aviation/contracts";

/**
 * Agent queue console (PRD F-4; F4 design pass): live priority-sorted queue
 * that shrinks as passengers self-serve, self-serve containment tile with
 * count-up motion (ui-design-system §6), keyboard-navigable rows with
 * `aria-expanded` disclosure (§9), expandable PNR context with proposal
 * decision cards. Live via SSE (`queue.delta` — agent+ streams) + 15 s poll
 * fallback.
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
  const listRef = useRef<HTMLDivElement | null>(null);

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

  /**
   * Roving-focus keyboard navigation over the queue rows (ui-design-system
   * §9: keyboard-navigable primary flows): ArrowUp/ArrowDown move focus,
   * Enter/Space toggles (native button behavior).
   */
  function onRowKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-queue-row]");
    if (!rows || rows.length === 0) return;
    const current = Array.from(rows).indexOf(event.currentTarget);
    const next = event.key === "ArrowDown" ? current + 1 : current - 1;
    rows[(next + rows.length) % rows.length]?.focus();
  }

  // Count-up animates only on KPI changes (ui-design-system §6). Targets are
  // hoisted so the hooks keep a stable order across loading/error/ready; "—"
  // stays the honest not-measurable value (D-15) and never animates a fake
  // number.
  const waitingTarget = state.phase === "ready" ? state.data.waiting : 0;
  const containmentTarget = state.phase === "ready" ? (state.data.containmentPct ?? 0) : 0;
  const proposalsTarget = state.phase === "ready" ? state.data.openProposals : 0;
  const waitingAnimated = Math.round(useCountUp(waitingTarget));
  const containmentAnimated = Math.round(useCountUp(containmentTarget));
  const proposalsAnimated = Math.round(useCountUp(proposalsTarget));

  if (state.phase === "loading") {
    return (
      <div className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-[4.5rem]" />
          <Skeleton className="h-[4.5rem]" />
          <Skeleton className="h-[4.5rem]" />
        </div>
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
      </div>
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
  const containment = data.containmentPct === null ? "—" : `${containmentAnimated}%`;

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <StatTile
          label="Waiting"
          value={String(waitingAnimated)}
          hint="disrupted PNRs awaiting assistance"
          testId="queue-waiting"
        />
        <StatTile
          label="Self-serve containment"
          value={containment}
          hint={
            data.containmentPct === null
              ? "not measurable — no disruption active"
              : "share resolved without an agent"
          }
          testId="queue-containment"
        />
        <StatTile
          label="Open proposals"
          value={String(proposalsAnimated)}
          hint="awaiting agent decision"
          testId="queue-open-proposals"
        />
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
          <div className="divide-y divide-border" ref={listRef}>
            <div
              className="grid grid-cols-[7rem_1fr_5rem_6rem_4.5rem_5rem] gap-2 px-4 py-2 text-[10px] uppercase tracking-wide text-muted"
              aria-hidden
            >
              <span>Locator</span>
              <span>Passenger</span>
              <span>Tier</span>
              <span>Flight</span>
              <span>Wait</span>
              <span>Offer</span>
            </div>
            {data.items.map((item) => {
              const isExpanded = expanded === item.locator;
              return (
                <div key={item.pnrId} data-testid={`queue-row-${item.locator}`}>
                  <button
                    type="button"
                    data-queue-row
                    onClick={() => void togglePnr(item.locator)}
                    onKeyDown={onRowKeyDown}
                    aria-expanded={isExpanded}
                    aria-controls={isExpanded ? `pnr-detail-${item.locator}` : undefined}
                    className="grid w-full grid-cols-[7rem_1fr_5rem_6rem_4.5rem_5rem] items-center gap-2 px-4 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-raised/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
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
                    <span className="font-mono text-xs tabular-nums text-muted">
                      {item.waitMinutes}m
                    </span>
                    <span className="font-mono text-[10px] text-muted">
                      {item.offerState ?? "—"}
                    </span>
                  </button>
                  {isExpanded && (
                    <div
                      id={`pnr-detail-${item.locator}`}
                      className="border-t border-border bg-raised/30 px-4 py-3"
                    >
                      {detail[item.locator] === "loading" && <Skeleton className="h-12 w-full" />}
                      {detail[item.locator] === null && (
                        <p className="text-xs text-danger">
                          Booking context unavailable right now.
                        </p>
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
              );
            })}
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
