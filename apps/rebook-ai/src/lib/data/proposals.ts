import { and, desc, eq } from "drizzle-orm";

import type { ProposalToolCall, ProposalView } from "@aviation/contracts";

import { offerOptions, proposals, sagaSteps, sagas, users } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";

/**
 * Proposal read models (PRD F-5, api-contracts.md §1 GET /proposals/{id}).
 * The orchestrator persists the loop output in proposals.trace as
 * `{ rationale, toolCalls }` (data-model.md §2 tool-call trace JSONB); this
 * module assembles the honesty badges (D-10), the supervisor elevation gate
 * (architecture.md §3.3) and the saga link once approval opened fulfillment.
 */

/** Persisted trace document shape (written by the orchestrator agent loop). */
interface StoredTrace {
  rationale?: unknown;
  toolCalls?: unknown;
}

function parseTrace(stored: unknown): { rationale: string; toolCalls: ProposalToolCall[] } {
  const trace = (stored ?? {}) as StoredTrace;
  const rationale = typeof trace.rationale === "string" ? trace.rationale : "";
  const toolCalls = Array.isArray(trace.toolCalls) ? (trace.toolCalls as ProposalToolCall[]) : [];
  return { rationale, toolCalls };
}

export async function getProposalView(proposalId: string): Promise<ProposalView | null> {
  const db = getSingletonDb();
  const [row] = await db
    .select({
      id: proposals.id,
      pnrId: proposals.pnrId,
      recommendedOptionId: proposals.recommendedOptionId,
      source: proposals.source,
      provider: proposals.provider,
      trace: proposals.trace,
      tokensIn: proposals.tokensIn,
      tokensOut: proposals.tokensOut,
      state: proposals.state,
      note: proposals.note,
      approver: users.displayName,
      createdAt: proposals.createdAt,
      decidedAt: proposals.decidedAt,
    })
    .from(proposals)
    .leftJoin(users, eq(proposals.approverId, users.id))
    .where(eq(proposals.id, proposalId))
    .limit(1);
  if (!row) return null;
  return assembleView(db, row);
}

export async function listProposalViews(pnrId: string, limit = 5): Promise<ProposalView[]> {
  const db = getSingletonDb();
  const rows = await db
    .select({
      id: proposals.id,
      pnrId: proposals.pnrId,
      recommendedOptionId: proposals.recommendedOptionId,
      source: proposals.source,
      provider: proposals.provider,
      trace: proposals.trace,
      tokensIn: proposals.tokensIn,
      tokensOut: proposals.tokensOut,
      state: proposals.state,
      note: proposals.note,
      approver: users.displayName,
      createdAt: proposals.createdAt,
      decidedAt: proposals.decidedAt,
    })
    .from(proposals)
    .leftJoin(users, eq(proposals.approverId, users.id))
    .where(eq(proposals.pnrId, pnrId))
    .orderBy(desc(proposals.createdAt))
    .limit(limit);
  const views: ProposalView[] = [];
  for (const row of rows) {
    views.push(await assembleView(db, row));
  }
  return views;
}

interface ProposalRowShape {
  id: string;
  pnrId: string;
  recommendedOptionId: string | null;
  source: "llm" | "rules";
  provider: string;
  trace: unknown;
  tokensIn: number;
  tokensOut: number;
  state: "proposed" | "approved" | "rejected";
  note: string | null;
  approver: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

async function assembleView(
  db: ReturnType<typeof getSingletonDb>,
  row: ProposalRowShape,
): Promise<ProposalView> {
  const { rationale, toolCalls } = parseTrace(row.trace);

  // Supervisor gate (architecture §3.3): interline partner or fare above the
  // tier cap — read from the recommended option's stored itinerary.
  const reasons: string[] = [];
  let offerId: string | null = null;
  if (row.recommendedOptionId) {
    const [option] = await db
      .select({
        offerId: offerOptions.offerId,
        interline: offerOptions.interline,
        itinerary: offerOptions.itinerary,
      })
      .from(offerOptions)
      .where(eq(offerOptions.id, row.recommendedOptionId))
      .limit(1);
    if (option) {
      offerId = option.offerId;
      if (option.interline) reasons.push("interline partner booking");
      const itinerary = option.itinerary as { overCap?: boolean } | null;
      if (itinerary?.overCap) reasons.push("fare above tier policy cap");
    }
  }

  // Saga link: the fulfillment saga opened by this proposal's approval —
  // the offer's saga created at (or after) the decision.
  let sagaId: string | null = null;
  if (row.state === "approved" && offerId) {
    const candidates = await db
      .select({ id: sagas.id, createdAt: sagas.createdAt })
      .from(sagas)
      .where(eq(sagas.offerId, offerId))
      .orderBy(desc(sagas.createdAt))
      .limit(1);
    const saga = candidates[0];
    if (saga && (!row.decidedAt || saga.createdAt >= row.decidedAt)) sagaId = saga.id;
  }

  return {
    id: row.id,
    pnrId: row.pnrId,
    offerId: offerId,
    state: row.state,
    source: row.source,
    provider: row.provider,
    recommendedOptionId: row.recommendedOptionId,
    rationale: rationale || "(no rationale recorded)",
    requiresSupervisor: { required: reasons.length > 0, reasons },
    trace: toolCalls,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    note: row.note,
    approver: row.approver,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    sagaId,
  };
}

/** Boarding-pass beat (demo-script.md): read from the ticket_issue response. */
export async function getBoardingPass(
  sagaId: string,
): Promise<{ ref: string; newFlightNo: string } | null> {
  const db = getSingletonDb();
  const [step] = await db
    .select({ response: sagaSteps.response })
    .from(sagaSteps)
    .where(and(eq(sagaSteps.sagaId, sagaId), eq(sagaSteps.step, "ticket_issue")))
    .limit(1);
  const response = (step?.response ?? {}) as {
    boardingPassRef?: unknown;
    flightNo?: unknown;
  };
  if (typeof response.boardingPassRef !== "string") return null;
  // The rebooked flight: first itinerary segment of the confirmed option —
  // derive from the saga's offer if not stored directly on the step.
  let newFlightNo = typeof response.flightNo === "string" ? response.flightNo : null;
  if (!newFlightNo) {
    const [saga] = await db
      .select({ offerId: sagas.offerId })
      .from(sagas)
      .where(eq(sagas.id, sagaId))
      .limit(1);
    if (saga) {
      const [option] = await db
        .select({ itinerary: offerOptions.itinerary })
        .from(offerOptions)
        .where(eq(offerOptions.offerId, saga.offerId))
        .orderBy(offerOptions.rank)
        .limit(1);
      const itinerary = option?.itinerary as { segments?: { flightNo?: string }[] } | null;
      newFlightNo = itinerary?.segments?.[0]?.flightNo ?? null;
    }
  }
  if (!newFlightNo) return null;
  return { ref: response.boardingPassRef, newFlightNo };
}
