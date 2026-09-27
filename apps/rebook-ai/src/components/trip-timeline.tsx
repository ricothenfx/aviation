"use client";

import { cn } from "@/lib/cn";
import type { PaxSummaryView } from "@aviation/contracts";

/**
 * Passenger journey timeline (PRD F-1…F-6 walk-through, F4): disruption →
 * offers → decision → fulfillment → new itinerary. Derived read-side from the
 * pax summary view — no new state. Stage color is always paired with a text
 * label (ui-design-system.md §2) and the active stage is the calm accent dot
 * from §6 (no flash, no bounce).
 */

type StageTone = "done" | "active" | "pending" | "failed";

interface Stage {
  key: string;
  label: string;
  sublabel: string;
  tone: StageTone;
  stamp: string | null;
}

const TONE_TEXT: Record<StageTone, string> = {
  done: "text-ok",
  active: "text-accent",
  pending: "text-muted",
  failed: "text-danger",
};

const TONE_GLYPH: Record<StageTone, string> = {
  done: "✓",
  active: "●",
  pending: "○",
  failed: "✕",
};

function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

export function TripTimeline({ data }: { data: PaxSummaryView }) {
  const disruption = data.disruption;
  const openOffers = data.offers.filter(
    (offer) => offer.state === "proposed" || offer.state === "confirmed",
  );
  const confirmed = data.offers.find((offer) => offer.confirmation);
  const saga = confirmed?.confirmation?.saga ?? null;
  const boardingPass = saga?.boardingPass ?? null;

  const stages: Stage[] = [
    {
      key: "disruption",
      label: "Disruption",
      sublabel: disruption
        ? `${disruption.flightNo} ${disruption.kind === "cancellation" ? "cancelled" : `delayed ${disruption.delayMinutes ?? 0} min`}`
        : "No IROP on your bookings",
      tone: disruption ? "done" : "pending",
      stamp: disruption ? hhmm(disruption.disruptedAt) : null,
    },
    {
      key: "offers",
      label: "Rebooking options",
      sublabel:
        openOffers.length > 0
          ? `${openOffers.length} ranked option set${openOffers.length > 1 ? "s" : ""} ready`
          : disruption
            ? "Ranking in progress — seconds away"
            : "Issued automatically when a flight breaks",
      tone: openOffers.length > 0 ? "done" : disruption ? "active" : "pending",
      stamp: openOffers[0] ? hhmm(openOffers[0].createdAt) : null,
    },
    {
      key: "decision",
      label: "Your decision",
      sublabel: confirmed
        ? `${confirmed.options.find((o) => o.id === confirmed.confirmation?.optionId)?.kind ?? "option"} confirmed`
        : openOffers.length > 0
          ? "One tap — or an agent prepares a proposal"
          : "Waiting for options",
      tone: confirmed ? "done" : openOffers.length > 0 ? "active" : "pending",
      stamp: confirmed?.confirmation ? hhmm(confirmed.confirmation.confirmedAt) : null,
    },
    {
      key: "fulfillment",
      label: "Fulfillment",
      sublabel: saga
        ? saga.state === "running"
          ? `Simulated saga · ${saga.currentStep ?? "in progress"}`
          : saga.state === "completed"
            ? "Seat · payment · ticket issued"
            : "Reversed — you are back in the queue"
        : "Runs automatically after the decision",
      tone: !saga
        ? confirmed
          ? "active"
          : "pending"
        : saga.state === "completed"
          ? "done"
          : saga.state === "failed" || saga.state === "compensated"
            ? "failed"
            : "active",
      stamp: null,
    },
    {
      key: "itinerary",
      label: "New itinerary",
      sublabel: boardingPass
        ? `${boardingPass.newFlightNo} · ${boardingPass.ref}`
        : "Boarding pass lands here after ticketing",
      tone: boardingPass ? "done" : saga?.state === "compensated" ? "failed" : "pending",
      stamp: null,
    },
  ];

  const activeIndex = stages.findIndex((stage) => stage.tone === "active");

  return (
    <section aria-label="Rebooking journey" data-testid="trip-timeline">
      <ol className="grid gap-2 md:grid-cols-5 md:gap-0">
        {stages.map((stage, index) => {
          const isCurrent = index === activeIndex;
          return (
            <li
              key={stage.key}
              data-testid={`timeline-${stage.key}`}
              data-tone={stage.tone}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex items-start gap-3 rounded-lg border px-3 py-2.5 md:flex-col md:gap-1.5 md:border-0 md:px-3",
                isCurrent && "border-border bg-raised/40",
                index > 0 && "md:border-l md:border-border/60 md:rounded-none",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]",
                    stage.tone === "done" && "border-ok/60 bg-ok/10",
                    stage.tone === "active" && "border-accent/60 bg-accent/10",
                    stage.tone === "pending" && "border-border",
                    stage.tone === "failed" && "border-danger/60 bg-danger/10",
                  )}
                >
                  {TONE_GLYPH[stage.tone]}
                </span>
                <span
                  className={cn(
                    "text-[11px] font-medium uppercase tracking-wide md:hidden",
                    TONE_TEXT[stage.tone],
                  )}
                >
                  {stage.tone === "active" ? "in progress" : stage.tone}
                </span>
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold text-fg">{stage.label}</span>
                  {stage.stamp && (
                    <span className="font-mono text-[10px] text-muted">{stage.stamp}</span>
                  )}
                </div>
                <p className={cn("mt-0.5 text-[11px] leading-snug md:pr-2", TONE_TEXT[stage.tone])}>
                  {stage.sublabel}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
