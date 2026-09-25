import type { NextRequest } from "next/server";

import { answerDetailSchema } from "@/lib/api/schemas";
import {
  ApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";
import { loadAnswerDetail } from "@/lib/answers";

/**
 * GET /api/v1/answers/{id} (api-contracts.md §1): detail + citations + review
 * block. Approved answers are visible to any signed-in user; non-approved
 * rows only to their author or a reviewer (FR-15 lifecycle visibility).
 */
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const session = await requireSession("viewer");
    const { id } = await context.params;
    const detail = await loadAnswerDetail(id);
    if (!detail) throw new ApiError("NOT_FOUND", `answer ${id} not found`);
    if (
      detail.status !== "approved" &&
      detail.createdBy !== session.sub &&
      session.role !== "reviewer"
    ) {
      throw new ApiError(
        "FORBIDDEN",
        "only the author or a reviewer can view a non-approved answer",
      );
    }
    return jsonResponse(answerDetailSchema.parse(detail));
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
