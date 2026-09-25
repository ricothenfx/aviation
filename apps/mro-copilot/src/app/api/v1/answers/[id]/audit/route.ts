import type { NextRequest } from "next/server";

import { auditEventSchema } from "@/lib/api/schemas";
import {
  ApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";
import { loadAnswerAudit, loadAnswerDetail } from "@/lib/answers";

/**
 * GET /api/v1/answers/{id}/audit (api-contracts.md §1): append-only lifecycle
 * events for one answer — reviewer+ or the answer's owner.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const session = await requireSession("viewer");
    const { id } = await context.params;
    if (session.role !== "reviewer") {
      const detail = await loadAnswerDetail(id);
      if (!detail) throw new ApiError("NOT_FOUND", `answer ${id} not found`);
      if (detail.createdBy !== session.sub) {
        throw new ApiError("FORBIDDEN", "audit trail is visible to the owner or a reviewer");
      }
    }
    const events = await loadAnswerAudit(id);
    return jsonResponse({ events: events.map((e) => auditEventSchema.parse(e)) });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
