import { createHash } from "node:crypto";

import type { ItinerarySegment, OptionKind, PnrTier } from "@aviation/contracts";
import type { SeedInventoryCandidate, SeedPolicy } from "rebook-ai/seed-fixtures";

/**
 * Offer ranking engine (PRD F-2, architecture.md §3.1). Pure + deterministic:
 * the same disruption + inventory snapshot yields the identical ranked offer
 * set (F2 DoD hash assert). Ranking weighs arrival time (fast), fare delta
 * under the tier policy cap (cheap) and flexibility (refundable/changeable,
 * same-carrier preferred). Every option carries a human-readable reason
 * (data-model.md §2 offer_options.reason) and its cap/interline flags.
 */

export interface RankingPnr {
  id: string;
  locator: string;
  tier: PnrTier;
  fareClass: string;
  partySize: number;
  refundable: boolean;
  changeable: boolean;
}

export interface DisruptionContext {
  flightNo: string;
  origin: string;
  dest: string;
  schedDep: string;
  schedArr: string;
  kind: "cancellation" | "long_delay";
  delayMinutes: number;
  reasonCode: string;
}

export interface RankOffersInput {
  pnr: RankingPnr;
  disruption: DisruptionContext;
  inventory: SeedInventoryCandidate[];
  policy: SeedPolicy;
  now: Date;
}

/** Pure ranking output — ids are assigned by the database on insert. */
export interface RankedOption {
  rank: number;
  kind: OptionKind;
  reason: string;
  segments: ItinerarySegment[];
  fareDelta: number;
  currency: string;
  interline: boolean;
  refundable: boolean;
  changeable: boolean;
  overCap: boolean;
}

export interface RankedOptionSet {
  options: RankedOption[];
  /** sha256 over the canonical option list — determinism evidence (F2 DoD). */
  rankingHash: string;
}

interface Pick {
  candidate: SeedInventoryCandidate;
  reason: string;
}

const KIND_ORDER: OptionKind[] = ["fast", "cheap", "flexible"];

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
}

function formatDuration(minutes: number): string {
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

function toSegment(candidate: SeedInventoryCandidate): ItinerarySegment {
  return {
    airline: candidate.airline,
    flightNo: candidate.flightNo,
    origin: candidate.origin,
    dest: candidate.dest,
    depart: candidate.depart,
    arrive: candidate.arrive,
    cabin: candidate.cabin,
  };
}

/** Deterministic candidate ordering — total order, no tie ambiguity. */
function byArrivalThenFlight(a: SeedInventoryCandidate, b: SeedInventoryCandidate): number {
  return (
    a.arrive.localeCompare(b.arrive) ||
    a.depart.localeCompare(b.depart) ||
    a.flightNo.localeCompare(b.flightNo)
  );
}

function byCheapest(a: SeedInventoryCandidate, b: SeedInventoryCandidate): number {
  return a.fareDelta - b.fareDelta || byArrivalThenFlight(a, b);
}

/** Eligible rebooking candidates for the disruption (PRD §6 domain rules). */
export function eligibleCandidates(input: RankOffersInput): SeedInventoryCandidate[] {
  const { disruption, inventory, pnr, now } = input;
  // Rebooking never departs before the original slot: for cancellations that is
  // the scheduled departure; for long delays it is the projected departure.
  const earliest =
    disruption.kind === "cancellation"
      ? Date.parse(disruption.schedDep)
      : Date.parse(disruption.schedDep) + disruption.delayMinutes * 60_000;
  return inventory
    .filter(
      (candidate) =>
        candidate.origin === disruption.origin &&
        candidate.dest === disruption.dest &&
        Date.parse(candidate.depart) >= earliest &&
        Date.parse(candidate.depart) >= now.getTime() &&
        candidate.seatsLeft >= pnr.partySize,
    )
    .sort(byArrivalThenFlight);
}

function fastPick(pool: SeedInventoryCandidate[], disruption: DisruptionContext): Pick | null {
  if (pool.length === 0) return null;
  const best = pool.reduce((acc, c) => (byArrivalThenFlight(c, acc) < 0 ? c : acc));
  const delta = minutesBetween(disruption.schedArr, best.arrive);
  const arrivalDelta =
    delta <= 0
      ? `arrives ${formatDuration(-delta)} earlier than your original flight`
      : `arrives ${formatDuration(delta)} later than your original flight`;
  return {
    candidate: best,
    reason: `Earliest arrival ${hhmm(best.arrive)} on ${best.flightNo}${
      best.interline ? ` (partner ${best.airline})` : ""
    } — ${arrivalDelta}`,
  };
}

function cheapPick(pool: SeedInventoryCandidate[], tier: PnrTier, policy: SeedPolicy): Pick | null {
  if (pool.length === 0) return null;
  const cap = policy.fareCaps[tier];
  const withinCap = pool.filter((c) => c.fareDelta <= cap);
  const overCap = withinCap.length === 0;
  const best = (overCap ? [...pool] : withinCap).sort(byCheapest)[0];
  if (!best) return null;
  const capNote = overCap
    ? `above your ${tier} policy cap of SGD ${cap} — requires agent review`
    : `within your ${tier} policy cap of SGD ${cap}`;
  return {
    candidate: best,
    reason: `Lowest fare difference SGD ${best.fareDelta} — ${capNote}`,
  };
}

function flexiblePick(pool: SeedInventoryCandidate[], disruption: DisruptionContext): Pick | null {
  if (pool.length === 0) return null;
  const sameCarrier = pool.filter((c) => c.airline === "NX");
  const candidates = sameCarrier.length > 0 ? sameCarrier : pool;
  const best = [...candidates].sort((a, b) => {
    const flexible =
      Number(b.refundable) - Number(a.refundable) || Number(b.changeable) - Number(a.changeable);
    return flexible || a.fareDelta - b.fareDelta || byArrivalThenFlight(a, b);
  })[0];
  if (!best) return null;
  const flex = best.refundable ? "refundable and changeable" : "changeable";
  const carrierNote = best.airline === "NX" ? "" : ` (partner ${best.airline})`;
  const delta = minutesBetween(disruption.schedArr, best.arrive);
  return {
    candidate: best,
    reason: `${best.flightNo}${carrierNote} — ${flex} itinerary keeps plans flexible; fare difference SGD ${best.fareDelta}, arrival ${formatDuration(delta)} vs original`,
  };
}

/** Canonical JSON (fixed key order) → sha256. Same inputs ⇒ same hash. */
export function offerSetHash(options: RankedOption[]): string {
  const canonical = JSON.stringify(
    options.map((o) => ({
      kind: o.kind,
      rank: o.rank,
      reason: o.reason,
      fareDelta: o.fareDelta,
      interline: o.interline,
      overCap: o.overCap,
      refundable: o.refundable,
      changeable: o.changeable,
      segments: o.segments.map((s) => [s.airline, s.flightNo, s.depart, s.arrive, s.cabin]),
    })),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export function rankOffers(input: RankOffersInput): RankedOptionSet {
  const { pnr, policy } = input;
  const candidates = eligibleCandidates(input);
  const cap = policy.fareCaps[pnr.tier];
  const maxOptions = Math.min(policy.offer.maxOptions, KIND_ORDER.length);

  const options: RankedOption[] = [];
  const remaining = [...candidates];

  const build = (kind: OptionKind, pick: (pool: SeedInventoryCandidate[]) => Pick | null): void => {
    if (options.length >= maxOptions) return;
    const picked = pick(remaining);
    if (!picked) return;
    const idx = remaining.indexOf(picked.candidate);
    if (idx >= 0) remaining.splice(idx, 1);
    options.push({
      rank: options.length + 1,
      kind,
      reason: picked.reason,
      segments: [toSegment(picked.candidate)],
      fareDelta: picked.candidate.fareDelta,
      currency: policy.currency,
      interline: picked.candidate.interline,
      refundable: picked.candidate.refundable,
      changeable: picked.candidate.changeable,
      overCap: picked.candidate.fareDelta > cap,
    });
  };

  build("fast", (pool) => fastPick(pool, input.disruption));
  build("cheap", (pool) => cheapPick(pool, pnr.tier, policy));
  build("flexible", (pool) => flexiblePick(pool, input.disruption));

  return { options, rankingHash: offerSetHash(options) };
}
