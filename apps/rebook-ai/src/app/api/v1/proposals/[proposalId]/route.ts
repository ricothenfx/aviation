import { proposalViewSchema } from "@aviation/contracts";

import { handleRouteError, jsonResponse, requireSession, ApiError } from "@/lib/api/respond";
import { getProposalView } from "@/lib/data/proposals";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/proposals/{id} (api-contracts.md §1) — proposal state incl. the
 * full tool trace and the `source`/`provider` honesty badges (D-10). 404
 * while the agent loop has not persisted the row yet (poll pattern).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ proposalId: string }> },
): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    await requireSession("agent");
    const { proposalId } = await context.params;
    const view = await getProposalView(proposalId);
    if (!view) throw new ApiError("NOT_FOUND", "proposal not found (still preparing?)");
    return jsonResponse(proposalViewSchema.parse(view));
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
