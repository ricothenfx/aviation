import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { answers } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { answerDetailSchema } from "@/lib/api/schemas";
import {
  MroApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";
import { withIdempotency } from "@/lib/api/idempotency";
import { loadAnswerDetail } from "@/lib/answers";
import { recordAudit } from "@/lib/audit";

/**
 * POST /api/v1/answers/{id}/approve (api-contracts.md §1, PRD FR-14):
 * `draft → approved`, reviewer only. Separation of duties: the answer's own
 * author can never approve it — SELF_APPROVAL_FORBIDDEN even with the reviewer
 * role. Transition is audit-recorded; approving a non-draft is 409.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const session = await requireSession("reviewer");
    const { id } = await context.params;

    return await withIdempotency(request, async () => {
      const db = getSingletonDb();
      const rows = await db
        .select({ id: answers.id, status: answers.status, createdBy: answers.createdBy })
        .from(answers)
        .where(eq(answers.id, id))
        .limit(1);
      const answer = rows[0];
      if (!answer) throw new MroApiError("NOT_FOUND", `answer ${id} not found`);
      if (answer.createdBy === session.sub) {
        throw new MroApiError(
          "SELF_APPROVAL_FORBIDDEN",
          "an answer may never be approved by its author (separation of duties)",
        );
      }
      if (answer.status !== "draft") {
        throw new MroApiError("LIFECYCLE_CONFLICT", `answer is ${answer.status}, not draft`);
      }

      const at = new Date().toISOString();
      await db
        .update(answers)
        .set({
          status: "approved",
          review: { reviewerId: session.sub, reviewerName: session.name, note: null, at },
        })
        .where(eq(answers.id, id));

      await recordAudit({
        eventType: "answer.approved",
        answerId: id,
        actorId: session.sub,
        payload: { reviewerName: session.name, at },
      });

      const detail = await loadAnswerDetail(id);
      return jsonResponse(answerDetailSchema.parse(detail));
    });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
