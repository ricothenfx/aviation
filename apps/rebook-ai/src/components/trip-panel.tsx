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
} from "@aviation/ui";
import type { OfferSetView, PaxSummaryView } from "@aviation/contracts";

import { TripTimeline } from "@/components/trip-timeline";

/**
 * Passenger trip surface (PRD F-1/F-2/F-3/F-6 at F2; F4 experience pass):
 * journey timeline (disruption → offers → decision → fulfillment → new
 * itinerary), ranked rebooking offers with per-rank reasons and one-tap
 * idempotent confirm, voucher wallet with explainable criteria, notification
 * inbox and the ARIA live region announcing incoming disruption/notification
 * (ui-design-system §9). Live updates arrive via SSE (`/api/v1/live`,
 * passenger-scoped) with a 30 s poll fallback; every state (loading/empty/
 * error/live) renders from real fetches (ui-design-system §7).
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

/** HH:MM in the scenario clock (timestamps are ISO strings on every view). */
function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

export function TripPanel() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState("");
  const seenRef = useRef<{ disrupted: boolean; notifications: number } | null>(null);

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

  // ARIA live region (ui-design-system §9): announce incoming disruption /
  // notification transitions once — diffed against the previous snapshot.
  useEffect(() => {
    if (state.phase !== "ready") return;
    const { data } = state;
    const seen = seenRef.current;
    seenRef.current = {
      disrupted: data.disruption !== null,
      notifications: data.notifications.length,
    };
    if (!seen) return;
    if (!seen.disrupted && data.disruption) {
      setAnnouncement(
        `Disruption on ${data.disruption.flightNo}: ${
          data.disruption.kind === "cancellation" ? "cancelled" : "delayed"
        }. Rebooking options are being prepared.`,
      );
    } else if (data.notifications.length > seen.notifications) {
      setAnnouncement(`New notification: ${data.notifications[0]?.subject ?? "inbox update"}`);
    }
  }, [state]);

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
      <div className="grid gap-4">
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64 w-full" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
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
      {/* Screen-reader announcements for incoming disruption/notifications. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <TripTimeline data={data} />

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
          label="Voucher wallet"
          value={data.vouchers.length > 0 ? `SGD ${voucherTotal}` : "0"}
          hint={
            data.vouchers.length > 0
              ? `${data.vouchers.length} voucher${data.vouchers.length > 1 ? "s" : ""} issued automatically`
              : "Issued automatically when policy criteria are met"
          }
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
                Scheduled {hhmm(data.disruption.schedDep)} · reason {data.disruption.reasonCode} ·
                ranked options are ready below — no queueing required.
              </div>
            </div>
            <StatusBadge tone="danger">
              {data.disruption.kind === "cancellation" ? "cancelled" : "delayed"}
            </StatusBadge>
          </div>
        </Panel>
      )}

      {confirmError && (
        <Panel className="border-l-4 border-l-danger">
          <p className="px-4 py-2 text-xs text-fg" role="alert">
            {confirmError}
          </p>
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
        <VoucherWallet vouchers={data.vouchers} />
        <Inbox notifications={data.notifications} />
      </div>

      <div className="flex items-center justify-between px-1">
        <span className="font-mono text-[11px] text-muted" aria-live="polite">
          updated {ageSeconds}s ago
        </span>
      </div>
    </div>
  );
}

/** Voucher wallet (PRD F-3): amount-first cards with the explainability trail. */
function VoucherWallet({ vouchers }: { vouchers: PaxSummaryView["vouchers"] }) {
  return (
    <Panel className="p-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-xs font-medium text-fg">Voucher wallet</span>
        <span className="font-mono text-[11px] text-muted">
          {vouchers.length > 0
            ? vouchers
                .map((v) => v.currency)
                .filter((c, i, a) => a.indexOf(c) === i)
                .join("/")
            : "—"}
        </span>
      </div>
      {vouchers.length === 0 ? (
        <EmptyState
          title="No vouchers"
          body="Meal vouchers are issued automatically when the disruption policy criteria are met — the evaluation trail appears here."
        />
      ) : (
        <div className="grid gap-3 p-4">
          {vouchers.map((voucher) => (
            <div
              key={voucher.id}
              data-testid="voucher-card"
              className="rounded-lg border border-border bg-raised/40"
            >
              <div className="flex items-center justify-between border-b border-dashed border-border px-4 py-3">
                <div>
                  <div className="font-mono text-xl tabular-nums text-fg">
                    {voucher.currency} {voucher.amount}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    issued {hhmm(voucher.issuedAt)} · {voucher.reason}
                  </div>
                </div>
                <StatusBadge tone={voucher.state === "issued" ? "ok" : "muted"}>
                  {voucher.state}
                </StatusBadge>
              </div>
              <ul className="space-y-1 px-4 py-3">
                {voucher.criteria.map((criterion) => (
                  <li key={criterion.rule} className="flex items-start gap-2 text-[11px]">
                    <span aria-hidden className={criterion.met ? "text-ok" : "text-muted"}>
                      {criterion.met ? "✓" : "✕"}
                    </span>
                    <span className="text-muted">
                      <span className="font-medium text-fg">{criterion.rule}</span> —{" "}
                      {criterion.detail}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="border-t border-dashed border-border px-4 py-2 text-[10px] text-muted">
                Simulated voucher — valid at participating outlets of the fictional carrier only.
              </p>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Notification inbox (PRD F-1): SNS-shaped, honest simulated delivery states. */
function Inbox({ notifications }: { notifications: PaxSummaryView["notifications"] }) {
  return (
    <Panel className="p-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-xs font-medium text-fg">Notification inbox</span>
        <LiveDot live label="live" />
      </div>
      {notifications.length === 0 ? (
        <EmptyState
          title="Inbox empty"
          body="Disruption notifications arrive here the moment your flight breaks — before you reach the counter."
        />
      ) : (
        <ul className="divide-y divide-border">
          {notifications.map((notification, index) => (
            <li key={notification.id} className="px-4 py-3" data-testid="inbox-item">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={
                    index === 0 ? "text-sm font-semibold text-fg" : "text-sm font-medium text-fg"
                  }
                >
                  {notification.subject}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted">
                  {timeAgo(notification.createdAt)}
                </span>
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{notification.body}</p>
              <div className="mt-1.5 flex items-center gap-2">
                <StatusBadge tone="muted">{notification.channel}</StatusBadge>
                <StatusBadge
                  tone={
                    notification.state === "delivered"
                      ? "ok"
                      : notification.state === "failed"
                        ? "danger"
                        : "warn"
                  }
                >
                  {notification.state}
                </StatusBadge>
                <span className="text-[10px] text-muted">simulated delivery</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
