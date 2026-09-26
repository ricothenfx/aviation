"use client";

import { useCallback, useEffect, useState } from "react";

import {
  Button,
  EmptyState,
  ErrorState,
  LiveDot,
  Panel,
  Skeleton,
  StatTile,
  StatusBadge,
} from "@aviation/ui";
import type { OfferSetView, PaxSummaryView } from "@aviation/contracts";

/**
 * Passenger trip surface (PRD F-1/F-2/F-3/F-6 at F2): disruption banner,
 * ranked rebooking offers with per-rank reasons, one-tap idempotent confirm,
 * explainable voucher criteria, notification inbox and the opened saga
 * (stub steps — the executor lands in F3). Live updates arrive via SSE
 * (`/api/v1/live`, passenger-scoped) with a 30 s poll fallback; every state
 * (loading/empty/error) renders from real fetches (ui-design-system §7).
 */

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; data: PaxSummaryView; fetchedAt: number }
  | { phase: "error"; message: string };

const KIND_LABEL = { fast: "Fast", cheap: "Cheap", flexible: "Flexible" } as const;

function timeAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

function countdown(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, "0")}`;
}

export function TripPanel() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
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
      const data = (await res.json()) as PaxSummaryView;
      setState({ phase: "ready", data, fetchedAt: Date.now() });
    } catch {
      setState({ phase: "error", message: "network error — is the stack running?" });
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 30_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    // Live updates: any offer/saga frame for our bookings triggers a refetch.
    const source = new EventSource("/api/v1/live");
    source.onmessage = () => void load();
    source.onerror = () => source.close();
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      source.close();
    };
  }, [load]);

  async function confirmOption(offer: OfferSetView, optionId: string): Promise<void> {
    setConfirming(optionId);
    setConfirmError(null);
    try {
      const res = await fetch(`/api/v1/pax/offers/${offer.id}/confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ optionId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string; code?: string };
        } | null;
        setConfirmError(body?.error?.message ?? `confirm failed (HTTP ${res.status})`);
        return;
      }
      await load();
    } catch {
      setConfirmError("network error — try again");
    } finally {
      setConfirming(null);
    }
  }

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

  const { data } = state;
  const ageSeconds = Math.max(0, Math.round((now - state.fetchedAt) / 1000));
  const voucherTotal = data.vouchers.reduce((sum, v) => sum + v.amount, 0);
  const proposedOffers = data.offers.filter(
    (o) => o.state === "proposed" || o.state === "confirmed",
  );

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <StatTile
          label="Active disruption"
          value={data.disruption ? data.disruption.flightNo : "None"}
          hint={
            data.disruption
              ? data.disruption.kind === "cancellation"
                ? "Cancelled — options below"
                : `Delayed ${data.disruption.delayMinutes ?? 0} min — options below`
              : "No IROP on your bookings"
          }
        />
        <StatTile
          label="Rebooking offers"
          value={String(proposedOffers.length)}
          hint="Ranked fast / cheap / flexible with reasons"
        />
        <StatTile
          label="Vouchers"
          value={data.vouchers.length > 0 ? `SGD ${voucherTotal}` : "0"}
          hint="Issued automatically when policy criteria are met"
        />
      </div>

      {data.disruption && (
        <Panel className="border-l-4 border-l-accent">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-fg">
                {data.disruption.flightNo} {data.disruption.origin}→{data.disruption.dest}{" "}
                {data.disruption.kind === "cancellation"
                  ? "is cancelled"
                  : `is delayed ${data.disruption.delayMinutes ?? 0} min`}
              </div>
              <div className="mt-0.5 text-xs text-muted">
                Rankéd rebooking options are ready below — no queueing required.
              </div>
            </div>
            <StatusBadge tone="danger">
              {data.disruption.kind === "cancellation" ? "cancelled" : "delayed"}
            </StatusBadge>
          </div>
        </Panel>
      )}

      {confirmError && (
        <Panel className="border-l-4 border-l-red-500">
          <p className="px-4 py-2 text-xs text-fg">{confirmError}</p>
        </Panel>
      )}

      {proposedOffers.length === 0 ? (
        <Panel className="p-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-xs font-medium text-fg">Rebooking offers</span>
            <LiveDot live label="live" />
          </div>
          <EmptyState
            title={data.disruption ? "Preparing your options" : "No active disruption"}
            body={
              data.disruption
                ? "Your ranked options appear here within seconds of the disruption."
                : "If your flight is disrupted, ranked rebooking options and any automatic voucher appear here within seconds — before you reach the counter."
            }
          />
        </Panel>
      ) : (
        proposedOffers.map((offer) => (
          <OfferCard
            key={offer.id}
            offer={offer}
            confirming={confirming}
            onConfirm={confirmOption}
            now={now}
          />
        ))
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Panel className="p-0">
          <div className="border-b border-border px-4 py-2.5">
            <span className="text-xs font-medium text-fg">Vouchers</span>
          </div>
          {data.vouchers.length === 0 ? (
            <EmptyState
              title="No vouchers"
              body="Meal vouchers are issued automatically when the disruption policy criteria are met."
            />
          ) : (
            <div className="divide-y divide-border">
              {data.vouchers.map((voucher) => (
                <div key={voucher.id} className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-fg">
                      {voucher.currency} {voucher.amount}
                    </span>
                    <StatusBadge tone="info">{voucher.state}</StatusBadge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">{voucher.reason}</div>
                  <ul className="mt-2 space-y-1">
                    {voucher.criteria.map((criterion) => (
                      <li key={criterion.rule} className="flex items-start gap-2 text-[11px]">
                        <span
                          aria-hidden
                          className={criterion.met ? "text-emerald-500" : "text-muted"}
                        >
                          {criterion.met ? "✓" : "✕"}
                        </span>
                        <span className="text-muted">
                          <span className="font-medium text-fg">{criterion.rule}</span> —{" "}
                          {criterion.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel className="p-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-xs font-medium text-fg">Notifications</span>
            <LiveDot live label="live" />
          </div>
          {data.notifications.length === 0 ? (
            <EmptyState
              title="Inbox empty"
              body="Disruption notifications arrive here the moment your flight breaks."
            />
          ) : (
            <div className="divide-y divide-border">
              {data.notifications.map((notification) => (
                <div key={notification.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-fg">{notification.subject}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted">
                      {timeAgo(notification.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">{notification.body}</p>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="flex items-center justify-between px-1">
        <span className="font-mono text-[11px] text-muted" aria-live="polite">
          updated {ageSeconds}s ago
        </span>
      </div>
    </div>
  );
}

function OfferCard({
  offer,
  confirming,
  onConfirm,
  now,
}: {
  offer: OfferSetView;
  confirming: string | null;
  onConfirm: (offer: OfferSetView, optionId: string) => Promise<void>;
  now: number;
}) {
  const expired = offer.state === "expired" || Date.parse(offer.expiresAt) < now;
  return (
    <Panel className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-fg">
            Rebooking options — {offer.context.flightNo}{" "}
            {offer.context.disruptionKind === "cancellation" ? "cancelled" : "delayed"}
          </span>
          {offer.state === "confirmed" && <StatusBadge tone="info">confirmed</StatusBadge>}
        </div>
        <span className="font-mono text-[11px] text-muted">
          {expired ? "expired" : `expires in ${countdown(offer.expiresAt)}`}
        </span>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-3">
        {offer.options.map((option) => {
          const isConfirmedOption = offer.confirmation?.optionId === option.id;
          const passengerBlocked = option.interline && offer.state === "proposed";
          return (
            <div
              key={option.id}
              className="flex flex-col rounded-lg border border-border bg-raised/40 p-3"
              data-testid={`option-${option.kind}`}
            >
              <div className="flex items-center justify-between">
                <StatusBadge
                  tone={option.kind === "fast" ? "info" : option.kind === "cheap" ? "ok" : "warn"}
                >
                  {KIND_LABEL[option.kind]}
                </StatusBadge>
                {option.interline && (
                  <span className="text-[10px] uppercase tracking-wide text-muted">partner</span>
                )}
              </div>
              <div className="mt-2 font-mono text-sm text-fg">
                {option.segments.map((s) => `${s.flightNo} ${s.origin}→${s.dest}`).join(" · ")}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-muted">
                {option.segments
                  .map((s) => `${s.depart.slice(11, 16)}→${s.arrive.slice(11, 16)} ${s.cabin}`)
                  .join(" · ")}
              </div>
              <p className="mt-2 flex-1 text-[11px] leading-relaxed text-muted">{option.reason}</p>
              <div className="mt-2 flex items-center justify-between">
                <span className="font-mono text-xs text-fg">
                  {option.fareDelta === 0 ? "no fare difference" : `+SGD ${option.fareDelta}`}
                </span>
                {isConfirmedOption ? (
                  <StatusBadge tone="ok">your choice</StatusBadge>
                ) : offer.state === "confirmed" ? null : expired ? (
                  <Button size="sm" variant="ghost" disabled>
                    Expired
                  </Button>
                ) : passengerBlocked ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled
                    title="Interline options require agent or supervisor assistance"
                  >
                    Agent help
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={option.kind === "fast" ? "primary" : "ghost"}
                    disabled={confirming !== null}
                    onClick={() => void onConfirm(offer, option.id)}
                  >
                    {confirming === option.id ? "Confirming…" : "Confirm"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {offer.confirmation && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg">Fulfillment saga</span>
            <StatusBadge
              tone={
                offer.confirmation.saga.state === "completed"
                  ? "ok"
                  : offer.confirmation.saga.state === "compensated" ||
                      offer.confirmation.saga.state === "failed"
                    ? "danger"
                    : "info"
              }
            >
              {offer.confirmation.saga.state}
            </StatusBadge>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {offer.confirmation.saga.steps.map((step) => (
              <span
                key={step.step}
                data-testid={`saga-step-${step.step}`}
                className="rounded-md border border-border bg-raised/40 px-2 py-1 font-mono text-[10px] text-muted"
              >
                {step.step}: {step.state}
              </span>
            ))}
          </div>

          {offer.confirmation.saga.state === "compensated" && (
            <p
              className="mt-2 text-[11px] text-danger"
              data-testid="saga-compensated-note"
              role="alert"
            >
              This rebooking was reversed during fulfillment and you are back in the assistance
              queue — pick an option again or wait for an agent.
            </p>
          )}

          {offer.confirmation.saga.boardingPass && (
            <div
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-raised/40 px-3 py-2"
              data-testid="boarding-pass"
            >
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted">
                  Boarding pass — simulated
                </div>
                <div className="mt-0.5 font-mono text-sm text-fg">
                  {offer.confirmation.saga.boardingPass.newFlightNo} ·{" "}
                  {offer.confirmation.saga.boardingPass.ref}
                </div>
              </div>
              <StatusBadge tone="ok">issued</StatusBadge>
            </div>
          )}

          <p className="mt-2 text-[10px] text-muted">
            Simulated fulfillment — steps advance automatically (seat reserved, simulated PSP
            charge, ticket issued).
          </p>
        </div>
      )}
    </Panel>
  );
}
