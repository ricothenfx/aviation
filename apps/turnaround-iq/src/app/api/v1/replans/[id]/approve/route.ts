import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { withIdempotency } from "@/lib/api/idempotency";
import { approveReplan } from "@/lib/data/replans";
import { getSingletonDb } from "@/lib/db-singleton";
import { getSingletonRedis } from "@/lib/redis-singleton";

export const dynamic = "force-dynamic";

const uuidSchema = z.string().uuid();

/**
 * POST /api/v1/replans/{id}/approve (api-contracts.md §1, PRD F-4) — coordinator+.
 * Records the human decision as an event; the engine applies the plan as
 * task.rescheduled events and the simulator adopts the new schedule.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    return await withIdempotency(request, async () => {
      const session = await requireSession("coordinator");
      const { id } = await context.params;
      const replanId = uuidSchema.parse(id);
      const result = await approveReplan({
        db: await getSingletonDb(),
        redis: await getSingletonRedis(),
        replanId,
        approvedBy: session.email,
      });
      return jsonResponse(result);
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
