import type { LlmGateway } from "@aviation/llm-gateway";
import { eq } from "drizzle-orm";

import type { AgentLoopOption } from "./agent-loop";

import type { OfferSetView } from "@aviation/contracts";
import { loadInventory, loadPolicy, seedDir } from "rebook-ai/seed-fixtures";

import { offers, offerOptions, pnr, flights, proposals } from "../db";
import { runProposalLoop } from "./agent-loop";
import { appendEvent } from "./event-log";
import type { SagaDeps } from "./saga";

/** Documented option itinerary persisted in offer_options.itinerary (JSONB). */
interface StoredItinerary {
  segments: AgentLoopOption["segments"];
  currency: string;
  refundable: boolean;
  changeable: boolean;
  overCap: boolean;
}

/**
 * F3 proposal persistence (architecture.md §3.3): runs the propose-only
 * agent loop for one offer and lands the result — proposals row (with the
 * full tool trace), `proposal.created` event, metrics. The web app's
 * approval route applies the decision; nothing here touches bookings
 * (propose-only invariant, api-contracts.md §5).
 */

export interface WorkerDeps extends SagaDeps {
  /** null = LLM_PROVIDER=off → rules-mode proposals (D-10 degrade). */
  gateway: LlmGateway | null;
}

export async function requestProposalForOffer(
  deps: WorkerDeps,
  input: { proposalId: string; pnrId: string; offerId: string },
): Promise<void> {
  const { db } = deps;
  const [booking] = await db
    .select({
      id: pnr.id,
      locator: pnr.locator,
      tier: pnr.tier,
      fareClass: pnr.fareClass,
      partySize: pnr.partySize,
    })
    .from(pnr)
    .where(eq(pnr.id, input.pnrId))
    .limit(1);
  if (!booking) throw new Error(`proposal request: unknown pnr ${input.pnrId}`);

  const [offer] = await db
    .select({ id: offers.id, context: offers.context })
    .from(offers)
    .where(eq(offers.id, input.offerId))
    .limit(1);
  if (!offer) throw new Error(`proposal request: unknown offer ${input.offerId}`);

  const context = offer.context as OfferSetView["context"];
  const [flight] = await db
    .select({
      flightNo: flights.flightNo,
      origin: flights.origin,
      dest: flights.dest,
      schedDep: flights.schedDep,
      schedArr: flights.schedArr,
    })
    .from(flights)
    .where(eq(flights.flightNo, context.flightNo))
    .limit(1);
  if (!flight) throw new Error(`proposal request: unknown flight ${context.flightNo}`);

  const optionRows = await db
    .select({
      id: offerOptions.id,
      rank: offerOptions.rank,
      kind: offerOptions.kind,
      reason: offerOptions.reason,
      itinerary: offerOptions.itinerary,
      fareDelta: offerOptions.fareDelta,
      interline: offerOptions.interline,
    })
    .from(offerOptions)
    .where(eq(offerOptions.offerId, offer.id))
    .orderBy(offerOptions.rank);

  const options: AgentLoopOption[] = optionRows.map((row) => {
    const itinerary = row.itinerary as StoredItinerary;
    return {
      id: row.id,
      rank: row.rank,
      kind: row.kind,
      reason: row.reason,
      segments: itinerary.segments,
      fareDelta: row.fareDelta,
      currency: itinerary.currency,
      interline: row.interline,
      refundable: itinerary.refundable,
      changeable: itinerary.changeable,
      overCap: itinerary.overCap,
    };
  });

  const started = Date.now();
  const result = await runProposalLoop({
    pnr: booking,
    offer: { id: offer.id, options },
    disruption: {
      flightNo: flight.flightNo,
      origin: flight.origin,
      dest: flight.dest,
      schedDep: flight.schedDep.toISOString(),
      schedArr: flight.schedArr.toISOString(),
      kind: context.disruptionKind,
      delayMinutes: context.delayMinutes,
    },
    inventory: loadInventory(seedDir()).candidates,
    policy: loadPolicy(seedDir()),
    now: new Date().toISOString(),
    gateway: deps.gateway,
  });

  await db
    .insert(proposals)
    .values({
      id: input.proposalId,
      pnrId: booking.id,
      recommendedOptionId: result.recommendedOptionId,
      source: result.source,
      provider: result.provider,
      trace: { rationale: result.rationale, toolCalls: result.toolCalls },
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      state: "proposed",
    })
    .onConflictDoNothing(); // idempotent under control-channel retries

  await appendEvent(db, {
    type: "proposal.created",
    aggregateType: "proposal",
    aggregateId: input.proposalId,
    payload: {
      proposalId: input.proposalId,
      pnrId: booking.id,
      source: result.source,
      provider: result.provider,
    },
  });

  deps.metrics.counters["rb_orchestrator_proposals_created_total"] =
    (deps.metrics.counters["rb_orchestrator_proposals_created_total"] ?? 0) + 1;
  deps.metrics.counters[
    result.source === "llm"
      ? "rb_orchestrator_proposals_llm_total"
      : "rb_orchestrator_proposals_rules_total"
  ] =
    (deps.metrics.counters[
      result.source === "llm"
        ? "rb_orchestrator_proposals_llm_total"
        : "rb_orchestrator_proposals_rules_total"
    ] ?? 0) + 1;
  deps.onLog("proposal_created", {
    proposalId: input.proposalId,
    pnrId: booking.id,
    source: result.source,
    provider: result.provider,
    recommendedOptionId: result.recommendedOptionId,
    toolCalls: result.toolCalls.length,
    latencyMs: Date.now() - started,
    proposalHash: result.proposalHash,
  });
}
