import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { explainReplan } from "@/lib/copilot/explain";
import { getSingletonDb } from "@/lib/db-singleton";

export const dynamic = "force-dynamic";

const uuidSchema = z.string().uuid();

/**
 * GET /api/v1/replans/{id}/explanation (api-contracts.md §1, PRD F-4, ADR-0003) —
 * coordinator+, same RBAC ladder as the replan decision endpoints. The copilot
 * explains the constraint engine's proposal through the LLM gateway (D-10);
 * with no provider available it degrades to the rule-based rationale and the
 * response carries the honest `source` label ("llm" | "rules").
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSession("coordinator");
    const { id } = await context.params;
    const replanId = uuidSchema.parse(id);
    const explanation = await explainReplan({ db: await getSingletonDb(), replanId });
    return jsonResponse(explanation);
  } catch (err) {
    return handleRouteError(err);
  }
}
