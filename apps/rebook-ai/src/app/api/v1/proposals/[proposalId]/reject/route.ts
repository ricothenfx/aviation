import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { proposalApproveResponseSchema } from "@aviation/contracts";

import { proposals } from "@/db/schema";
import { withIdempotency } from "@/lib/api/idempotency";
import { handleRouteError, jsonResponse, requireSession, ApiError } from "@/lib/api/respond";
import { appendAuditEvent, appendEvent } from "@/lib/data/events";
import { getSingletonDb } from "@/lib/db-singleton";

export const dynamic = "force-dynamic";

const rejectRequestSchema = z.object({ note: z.string().min(1).max(500) });

/**
 * POST /api/v1/proposals/{id}/reject (api-contracts.md §1) — mandatory note;
 * appends `proposal.rejected` + the audit row in one transaction. A rejected
 * proposal mutates nothing else: the offer stays open for the passenger
 * (propose-only invariant, PRD F-5).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ proposalId: string }> },
): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const session = await requireSession("agent");
    const { proposalId } = await context.params;

    return await withIdempotency(request, {}, async () => {
      const body = rejectRequestSchema.parse(await request.json().catch(() => ({})));
      const db = getSingletonDb();
      const [proposal] = await db
        .select({ id: proposals.id, state: proposals.state })
        .from(proposals)
        .where(eq(proposals.id, proposalId))
        .limit(1);
      if (!proposal) throw new ApiError("NOT_FOUND", "proposal not found");
      if (proposal.state !== "proposed") {
        throw new ApiError("PROPOSAL_NOT_PENDING", "proposal has already been decided");
      }

      await db.transaction(async (tx) => {
        await tx
          .update(proposals)
          .set({
            state: "rejected",
            approverId: session.sub,
            note: body.note,
            decidedAt: new Date(),
          })
          .where(eq(proposals.id, proposalId));
        await appendEvent(
          {
            type: "proposal.rejected",
            aggregateType: "proposal",
            aggregateId: proposalId,
            payload: { proposalId, approverId: session.sub, note: body.note },
          },
          tx,
        );
        await appendAuditEvent(
          {
            actorId: session.sub,
            actorRole: session.role,
            action: "proposal.rejected",
            targetType: "proposal",
            targetId: proposalId,
            details: { note: body.note },
          },
          tx,
        );
      });

      return jsonResponse(
        proposalApproveResponseSchema.parse({
          proposalId,
          state: "rejected",
          sagaId: null,
        }),
        201,
      );
    });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
