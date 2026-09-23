import { and, desc, eq, inArray } from "drizzle-orm";

import type { Db } from "@aviation/db/client";
import { events, flights, groundTasks, stands } from "@aviation/db/schema";
import {
  ApiError,
  replanExplanationSchema,
  replanProposedPayloadSchema,
  type ReplanExplanation,
} from "@aviation/contracts";
import { LlmGateway, ProviderUnavailableError, type ChatMessage } from "@aviation/llm-gateway";

/**
 * Copilot plan explanation (PRD F-4, api-contracts.md §1 replans/explanation,
 * ADR-0003 + D-10): every LLM call goes through the provider-agnostic gateway;
 * the constraint engine's schedule is the ground truth and the copilot only
 * NARRATES it. When no provider is available the deterministic rule-based
 * rationale answers instead and the response is labeled `source: "rules"`.
 * The label is contract, not decoration — tests pin both paths.
 */

export interface ReplanFacts {
  replanId: string;
  flightNo: string;
  standCode: string;
  /** Projected departure slip with the plan applied (minutes). */
  totalDelayMin: number;
  /** Do-nothing departure slip, or null when unprojectable (engine sends −1). */
  baselineDelayMin: number | null;
  /** Deterministic scheduler rationale (services/turnaround-iq/domain scheduler.ts). */
  rationale: string;
  movedTasks: Array<{ taskType: string; newStart: string; newEnd: string }>;
}

/** Load the replan.proposed event + flight/task context for one replan id. */
export async function loadReplanFacts(db: Db, replanId: string): Promise<ReplanFacts> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.aggregateId, replanId), eq(events.type, "replan.proposed")))
    .orderBy(desc(events.sequence))
    .limit(1);
  const event = rows[0];
  if (!event) throw new ApiError("NOT_FOUND", `replan ${replanId} not found`);
  const payload = replanProposedPayloadSchema.parse(event.payload);

  const flightRows = await db
    .select({ flightNo: flights.flightNo, standCode: stands.code })
    .from(flights)
    .innerJoin(stands, eq(stands.id, flights.standId))
    .where(eq(flights.id, payload.flightId))
    .limit(1);
  const flight = flightRows[0];
  if (!flight) throw new ApiError("NOT_FOUND", `flight ${payload.flightId} not found`);

  const taskIds = payload.delta.map((item) => item.taskId);
  const typeById = new Map<string, string>();
  if (taskIds.length > 0) {
    const taskRows = await db
      .select({ id: groundTasks.id, type: groundTasks.type })
      .from(groundTasks)
      .where(inArray(groundTasks.id, taskIds));
    for (const row of taskRows) typeById.set(row.id, row.type);
  }

  return {
    replanId,
    flightNo: flight.flightNo,
    standCode: flight.standCode,
    totalDelayMin: payload.totalDelayMin,
    baselineDelayMin: payload.baselineDelayMin ?? null,
    rationale: payload.rationale,
    movedTasks: payload.delta.map((item) => ({
      taskType: typeById.get(item.taskId) ?? "task",
      newStart: item.newStart,
      newEnd: item.newEnd,
    })),
  };
}

function fmtZ(iso: string): string {
  return `${iso.slice(11, 16)}Z`;
}

function baselineText(facts: ReplanFacts): string {
  // −1 is the engine's "unprojectable" sentinel — report it honestly as absent.
  if (facts.baselineDelayMin === null || facts.baselineDelayMin < 0) {
    return "no do-nothing baseline available";
  }
  const saved = facts.baselineDelayMin - facts.totalDelayMin;
  return `do-nothing baseline ${facts.baselineDelayMin} min, so the plan saves ${saved} min`;
}

/** Deterministic rule-based explanation — the ADR-0003 degrade path. */
export function rulesNarrative(facts: ReplanFacts): string {
  const moved =
    facts.movedTasks.length === 0
      ? "no tasks need to move"
      : `${facts.movedTasks.length} task${facts.movedTasks.length === 1 ? "" : "s"} move`;
  const first = facts.movedTasks[0];
  const detail = first
    ? ` First move: ${first.taskType} to ${fmtZ(first.newStart)}–${fmtZ(first.newEnd)}.`
    : "";
  return [
    `Rule-based rationale (LLM provider unavailable): the constraint scheduler re-sequences ${facts.flightNo} on stand ${facts.standCode} under task dependencies, unit availability and fueling/boarding safety — ${moved}.`,
    detail,
    ` Projected departure slip stays at ${facts.totalDelayMin} min (${baselineText(facts)}). Scheduler summary: ${facts.rationale}`,
  ].join("");
}

/** Deterministic grounding prompt: facts only, no schedule authority (PRD §4). */
export function copilotMessages(facts: ReplanFacts): ChatMessage[] {
  const deltaLines =
    facts.movedTasks.length === 0
      ? "- none (the plan keeps the current sequence)"
      : facts.movedTasks
          .map((task) => `- ${task.taskType}: ${fmtZ(task.newStart)}–${fmtZ(task.newEnd)}`)
          .join("\n");
  return [
    {
      role: "system",
      content:
        "You are TurnaroundIQ's copilot for aircraft turnaround coordinators. Explain the " +
        "constraint engine's replan plan in at most 4 short sentences of plain ops English. " +
        "Use ONLY the facts provided — never invent tasks, times, units or numbers. " +
        "You never decide schedules; the constraint engine does and a human approves.",
    },
    {
      role: "user",
      content: [
        `Flight ${facts.flightNo} on stand ${facts.standCode}.`,
        `Constraint scheduler rationale: ${facts.rationale}`,
        `Projected departure slip with the plan: ${facts.totalDelayMin} min (${baselineText(facts)}).`,
        "Rescheduled tasks:",
        deltaLines,
      ].join("\n"),
    },
  ];
}

/** Pure label logic over facts + any gateway (unit-tested for both sources). */
export async function explainFromFacts(args: {
  facts: ReplanFacts;
  /** null = no provider configured → straight to the rules narrative. */
  gateway: Pick<LlmGateway, "complete" | "providerName"> | null;
  now?: string;
}): Promise<ReplanExplanation> {
  const generatedAt = args.now ?? new Date().toISOString();
  try {
    if (!args.gateway) {
      throw new ProviderUnavailableError("no LLM provider configured");
    }
    const result = await args.gateway.complete({
      messages: copilotMessages(args.facts),
      temperature: 0.2,
      maxTokens: 300,
    });
    return replanExplanationSchema.parse({
      replanId: args.facts.replanId,
      source: "llm",
      provider: result.provider,
      text: result.text,
      generatedAt,
    });
  } catch (err) {
    // ADR-0003: any provider unavailability degrades to the rules engine.
    if (!(err instanceof ProviderUnavailableError)) throw err;
    return replanExplanationSchema.parse({
      replanId: args.facts.replanId,
      source: "rules",
      provider: null,
      text: rulesNarrative(args.facts),
      generatedAt,
    });
  }
}

/** Route-level orchestrator: facts from the event log, gateway from env. */
export async function explainReplan(args: {
  db: Db;
  replanId: string;
  gateway?: Pick<LlmGateway, "complete" | "providerName">;
}): Promise<ReplanExplanation> {
  const facts = await loadReplanFacts(args.db, args.replanId);
  // fromEnv() THROWS when no provider is configured — that is a degrade signal
  // (ADR-0003), not a 500, so construction happens inside the labeled path.
  const gateway =
    args.gateway ??
    (() => {
      try {
        return LlmGateway.fromEnv();
      } catch (err) {
        if (err instanceof ProviderUnavailableError) return null;
        throw err;
      }
    })();
  return explainFromFacts({ facts, gateway });
}
