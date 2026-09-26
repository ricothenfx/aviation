import { createHash } from "node:crypto";

import type { LlmGateway } from "@aviation/llm-gateway";
import type { ItinerarySegment, PnrTier } from "@aviation/contracts";
import type { SeedInventoryCandidate, SeedPolicy } from "rebook-ai/seed-fixtures";

import { eligibleCandidates } from "./ranking";

/**
 * Propose-only agent loop (PRD F-5, architecture.md §3.3, ADR-0003/D-10).
 *
 * Bedrock-AgentCore-shaped: a bounded, traced tool loop over READ-ONLY tools
 * (`search_routings` → `price_itinerary` → `check_policy` → `draft_proposal`)
 * that evaluates the offer's ranked options against the fictional inventory
 * and policy fixtures. The output is a decision proposal — this module never
 * touches bookings, offers or inventory counters (propose-only invariant,
 * api-contracts.md §5; only web-side approval applies via the saga path).
 *
 * Degrade honesty (D-10): with a gateway (mock or real) the draft round
 * prompts the LLM with numbered tool-output blocks and the proposal is
 * labeled `source: "llm"` + the provider name; with `gateway: null`
 * (LLM_PROVIDER=off) the identical deterministic pick is labeled
 * `source: "rules"`, provider `rules-engine`. Both modes are fully
 * deterministic: same inputs ⇒ same proposal (hash assert, F3 DoD).
 */

export interface AgentLoopPnr {
  id: string;
  locator: string;
  tier: PnrTier;
  fareClass: string;
  partySize: number;
}

export interface AgentLoopOption {
  id: string;
  rank: number;
  kind: string;
  reason: string;
  segments: ItinerarySegment[];
  fareDelta: number;
  currency: string;
  interline: boolean;
  refundable: boolean;
  changeable: boolean;
  overCap: boolean;
}

export interface AgentLoopDisruption {
  flightNo: string;
  origin: string;
  dest: string;
  schedDep: string;
  schedArr: string;
  kind: "cancellation" | "long_delay";
  delayMinutes: number;
}

export interface ProposalLoopInput {
  pnr: AgentLoopPnr;
  offer: { id: string; options: AgentLoopOption[] };
  disruption: AgentLoopDisruption;
  inventory: SeedInventoryCandidate[];
  policy: SeedPolicy;
  /** Scenario wall clock (ISO) — an input so runs stay reproducible. */
  now: string;
  /** null = provider off (D-10 degrade to rules). */
  gateway: LlmGateway | null;
}

export interface ProposalToolCall {
  tool: "search_routings" | "price_itinerary" | "check_policy" | "draft_proposal";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  durationMs: number;
  tokens?: { input: number; output: number };
}

export interface ProposalLoopOutput {
  source: "llm" | "rules";
  provider: string;
  recommendedOptionId: string | null;
  rationale: string;
  toolCalls: ProposalToolCall[];
  tokensIn: number;
  tokensOut: number;
  /** sha256 over the canonical proposal — determinism evidence (F3 DoD). */
  proposalHash: string;
}

const MAX_ROUNDS = 4; // bounded loop: search + price + policy + draft (§3.3)
const SEARCH_RESULT_CAP = 8;

function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

/** Deterministic market view: eligible candidates incl. interline partners. */
function searchRoutings(input: ProposalLoopInput): {
  io: { input: Record<string, unknown>; output: Record<string, unknown> };
  summary: string;
} {
  const notBefore =
    input.disruption.kind === "cancellation"
      ? input.disruption.schedDep
      : new Date(
          Date.parse(input.disruption.schedDep) + input.disruption.delayMinutes * 60_000,
        ).toISOString();
  const eligible = eligibleCandidates({
    pnr: {
      id: input.pnr.id,
      locator: input.pnr.locator,
      tier: input.pnr.tier,
      fareClass: input.pnr.fareClass,
      partySize: input.pnr.partySize,
      refundable: false,
      changeable: false,
    },
    disruption: { ...input.disruption, reasonCode: "AGENT_SEARCH" },
    inventory: input.inventory,
    policy: input.policy,
    now: new Date(input.now),
  });
  const flights = eligible.slice(0, SEARCH_RESULT_CAP).map((c) => ({
    flightNo: c.flightNo,
    airline: c.airline,
    depart: c.depart,
    arrive: c.arrive,
    seatsLeft: c.seatsLeft,
    fareDelta: c.fareDelta,
    interline: c.interline,
  }));
  return {
    io: {
      input: {
        origin: input.disruption.origin,
        dest: input.disruption.dest,
        notBefore,
        partySize: input.pnr.partySize,
        includePartners: true,
      },
      output: {
        matched: eligible.length,
        flights,
        partnersIncluded: eligible.some((c) => c.interline),
      },
    },
    summary:
      `search_routings found ${eligible.length} eligible flights ` +
      `${input.disruption.origin} to ${input.disruption.dest} for a party of ` +
      `${input.pnr.partySize} departing no earlier than ${hhmm(notBefore)}, ` +
      `interline partners ${eligible.some((c) => c.interline) ? "included" : "not available"}.`,
  };
}

function priceItinerary(
  input: ProposalLoopInput,
  flightNo: string,
): { io: { input: Record<string, unknown>; output: Record<string, unknown> }; summary: string } {
  const candidate = input.inventory.find((c) => c.flightNo === flightNo) ?? null;
  const cap = input.policy.fareCaps[input.pnr.tier];
  return {
    io: {
      input: { flightNo, tier: input.pnr.tier },
      output:
        candidate === null
          ? { found: false }
          : {
              found: true,
              fareDelta: candidate.fareDelta,
              currency: input.policy.currency,
              tierCap: cap,
              withinCap: candidate.fareDelta <= cap,
              refundable: candidate.refundable,
              changeable: candidate.changeable,
            },
    },
    summary:
      candidate === null
        ? `price_itinerary: ${flightNo} is not in the rebooking inventory.`
        : `price_itinerary: ${flightNo} costs SGD ${candidate.fareDelta} extra, ` +
          `${candidate.fareDelta <= cap ? "within" : "above"} the ${input.pnr.tier} cap of ` +
          `SGD ${cap}.`,
  };
}

function checkPolicy(
  input: ProposalLoopInput,
  option: AgentLoopOption,
  seatsAvailable: number | null,
): { io: { input: Record<string, unknown>; output: Record<string, unknown> }; summary: string } {
  const cap = input.policy.fareCaps[input.pnr.tier];
  const seatsOk = seatsAvailable === null ? null : seatsAvailable >= input.pnr.partySize;
  const reasons: string[] = [];
  if (option.fareDelta > cap) {
    reasons.push(`fare delta ${option.fareDelta} above ${input.pnr.tier} cap ${cap}`);
  }
  if (option.interline) reasons.push("interline partner requires supervisor approval");
  if (option.overCap) reasons.push("above tier fare cap requires supervisor approval");
  return {
    io: {
      input: { optionId: option.id, flightNo: option.segments[0]?.flightNo ?? null },
      output: {
        withinCap: option.fareDelta <= cap,
        tierCap: cap,
        interline: option.interline,
        overCap: option.overCap,
        seatsAvailable,
        seatsOk,
        departureNotBeforeOriginal: true, // ranking engine guarantees the rule
        compliant: reasons.length === 0,
        gateReasons: reasons,
      },
    },
    summary:
      `check_policy: ${option.segments[0]?.flightNo ?? option.id} is ` +
      `${reasons.length === 0 ? "policy compliant" : `gated: ${reasons.join(", ")}`}.`,
  };
}

function seatsForOption(
  flights: { flightNo: string; seatsLeft: number }[],
  flightNo: string | undefined,
): number | null {
  if (!flightNo) return null;
  return flights.find((f) => f.flightNo === flightNo)?.seatsLeft ?? null;
}

/**
 * Deterministic recommendation: earliest arrival, then fare delta, then
 * flight number — no tie ambiguity. Policy gates (interline / over-cap) do
 * NOT suppress the recommendation: the agent proposes the best option and
 * surfaces the supervisor gate (architecture.md §3.3 — the gate lives at
 * approval, which is exactly what the RBAC elevation enforces).
 */
function pickRecommended(
  options: AgentLoopOption[],
  _policyOutputs: Record<string, { compliant: boolean } | Record<string, unknown>>,
): AgentLoopOption | null {
  const sorted = [...options].sort((a, b) => {
    const arr = a.segments[0]?.arrive.localeCompare(b.segments[0]?.arrive ?? "");
    if (arr !== 0) return arr ?? 0;
    if (a.fareDelta !== b.fareDelta) return a.fareDelta - b.fareDelta;
    return (a.segments[0]?.flightNo ?? "").localeCompare(b.segments[0]?.flightNo ?? "");
  });
  return sorted[0] ?? null;
}

function rulesRationale(
  input: ProposalLoopInput,
  recommended: AgentLoopOption | null,
  policyOutput: Record<string, unknown> | undefined,
): string {
  if (!recommended) {
    return `No policy-compliant rebooking option found for ${input.pnr.locator} — manual agent handling required.`;
  }
  const flightNo = recommended.segments[0]?.flightNo ?? "unknown";
  const arrive = recommended.segments[0]?.arrive ? hhmm(recommended.segments[0].arrive) : "??:??";
  const cap = input.policy.fareCaps[input.pnr.tier];
  const gates = (policyOutput?.gateReasons as string[] | undefined) ?? [];
  const gateNote = gates.length > 0 ? ` Supervisor approval required: ${gates.join("; ")}.` : "";
  return (
    `Recommended ${flightNo} — earliest arrival ${arrive} with fare difference ` +
    `SGD ${recommended.fareDelta} ${recommended.fareDelta <= cap ? "within" : "above"} your ` +
    `${input.pnr.tier} cap of SGD ${cap}.${gateNote}`
  );
}

/** Grounded prompt shape: numbered tool-output blocks + question (ADR-0003). */
function draftPrompt(blocks: string[], question: string): string {
  return `${blocks.map((block, idx) => `[${idx + 1}] ${block}`).join("\n")}\nQuestion: ${question}\nMaxBlocks: 3`;
}

function proposalHashOf(
  input: ProposalLoopInput,
  output: Omit<ProposalLoopOutput, "proposalHash">,
): string {
  // Canonical over decision-relevant fields only — never timing (durationMs).
  const canonical = JSON.stringify({
    pnrId: input.pnr.id,
    offerId: input.offer.id,
    source: output.source,
    provider: output.provider,
    recommendedOptionId: output.recommendedOptionId,
    rationale: output.rationale,
    tokensIn: output.tokensIn,
    tokensOut: output.tokensOut,
    toolCalls: output.toolCalls.map((call) => ({
      tool: call.tool,
      input: call.input,
      output: call.output,
      tokens: call.tokens ?? null,
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

interface TraceRound {
  call: Omit<ProposalToolCall, "durationMs">;
  durationMs: number;
  summary: string;
}

/** Run the bounded propose-only loop. Pure with respect to persisted state. */
export async function runProposalLoop(input: ProposalLoopInput): Promise<ProposalLoopOutput> {
  const started = Date.now();
  const rounds: TraceRound[] = [];
  let round = 0;
  // Bounded rounds (§3.3): search → price ×n → policy ×n → draft.
  const trace = (
    tool: TraceRound["call"]["tool"],
    fn: () => {
      io: { input: Record<string, unknown>; output: Record<string, unknown> };
      summary: string;
    },
    tokens?: { input: number; output: number },
  ): {
    io: { input: Record<string, unknown>; output: Record<string, unknown> };
    summary: string;
  } => {
    if (round >= MAX_ROUNDS + input.offer.options.length * 2) {
      throw new Error(`agent loop exceeded ${MAX_ROUNDS} rounds`);
    }
    round += 1;
    const at = Date.now();
    const result = fn();
    rounds.push({
      call: {
        tool,
        input: result.io.input,
        output: result.io.output,
        ...(tokens ? { tokens } : {}),
      },
      durationMs: Date.now() - at,
      summary: result.summary,
    });
    return result;
  };

  // Round — search the market (read-only, incl. interline partners).
  const search = trace("search_routings", () => searchRoutings(input));

  // Rounds — price + policy check every ranked option of the open offer.
  const summaries = [search.summary];
  const policyOutputs: Record<string, Record<string, unknown>> = {};
  for (const option of input.offer.options) {
    const flightNo = option.segments[0]?.flightNo ?? option.id;
    const price = trace("price_itinerary", () => priceItinerary(input, flightNo));
    summaries.push(price.summary);
    const seats = seatsForOption(
      search.io.output.flights as { flightNo: string; seatsLeft: number }[],
      option.segments[0]?.flightNo,
    );
    const policy = trace("check_policy", () => checkPolicy(input, option, seats));
    summaries.push(policy.summary);
    policyOutputs[option.id] = policy.io.output;
  }

  // Draft round — deterministic pick; LLM-composed rationale when a provider
  // is configured, rule-composed (identical decision) when off (D-10).
  const recommended = pickRecommended(input.offer.options, policyOutputs);
  const recommendedPolicy = recommended ? policyOutputs[recommended.id] : undefined;
  let source: "llm" | "rules";
  let provider: string;
  let rationale: string;
  let tokensIn = 0;
  let tokensOut = 0;

  if (input.gateway && recommended) {
    source = "llm";
    provider = input.gateway.providerName;
    const prompt = draftPrompt(
      summaries,
      `Draft the rebooking proposal for passenger ${input.pnr.locator} ` +
        `(${input.pnr.tier} tier, party of ${input.pnr.partySize}) disrupted on ` +
        `${input.disruption.flightNo}. Recommended option: ` +
        `${recommended.segments[0]?.flightNo ?? "none"}. State the arrival, the fare ` +
        "difference and any approval gate.",
    );
    const at = Date.now();
    const completion = await input.gateway.complete({
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    });
    tokensIn = completion.usage.inputTokens;
    tokensOut = completion.usage.outputTokens;
    rounds.push({
      call: {
        tool: "draft_proposal",
        input: { mode: "llm", promptChars: prompt.length },
        output: { text: completion.text, provider: completion.provider },
        tokens: { input: completion.usage.inputTokens, output: completion.usage.outputTokens },
      },
      durationMs: Date.now() - at,
      summary: completion.text,
    });
    rationale = completion.text;
  } else {
    source = "rules";
    provider = "rules-engine";
    rationale = rulesRationale(input, recommended, recommendedPolicy);
    rounds.push({
      call: {
        tool: "draft_proposal",
        input: { mode: "rules" },
        output: { text: rationale, provider },
      },
      durationMs: Date.now() - started,
      summary: rationale,
    });
  }

  const toolCalls: ProposalToolCall[] = rounds.map((r) => ({
    ...r.call,
    durationMs: r.durationMs,
  }));
  const partial = {
    source,
    provider,
    recommendedOptionId: recommended?.id ?? null,
    rationale,
    toolCalls,
    tokensIn,
    tokensOut,
  };
  return { ...partial, proposalHash: proposalHashOf(input, partial) };
}
