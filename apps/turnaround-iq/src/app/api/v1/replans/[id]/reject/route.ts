import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { withIdempotency } from "@/lib/api/idempotency";
import { rejectReplan } from "@/lib/data/replans";
import { getSingletonDb } from "@/lib/db-singleton";
import { getSingletonRedis } from "@/lib/redis-singleton";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: z.string().min(1).max(500) });
const uuidSchema = z.string().uuid();

/**
 * POST /api/v1/replans/{id}/reject {reason} (api-contracts.md §1) — coordinator+.
 * Audit-recorded; the proposal stays visible in the flight's event history.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    return await withIdempotency(request, async () => {
      const session = await requireSession("coordinator");
      const { id } = await context.params;
      const replanId = uuidSchema.parse(id);
      const body = bodySchema.parse(await request.json().catch(() => ({})));
      const result = await rejectReplan({
        db: await getSingletonDb(),
        redis: await getSingletonRedis(),
        replanId,
        rejectedBy: session.email,
        reason: body.reason,
      });
      return jsonResponse(result);
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
