import type { NextRequest } from "next/server";

import { pnrDetailViewSchema } from "@aviation/contracts";
import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { buildPnrDetail, getPnrByLocator } from "@/lib/data/views";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/pnr/{locator} (rebook-ai api-contracts.md §1) — PNR-like record
 * + segments + disruption context for agents (agent+ only, PRD F-7).
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ locator: string }> },
): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    await requireSession("agent");
    const { locator } = await context.params;
    const record = await getPnrByLocator(locator.toUpperCase());
    if (!record) {
      return jsonResponse(
        { error: { code: "NOT_FOUND", message: `no booking ${locator}`, requestId } },
        404,
      );
    }
    const detail = pnrDetailViewSchema.parse(await buildPnrDetail(record));
    return jsonResponse(detail);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
