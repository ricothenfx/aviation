import type { NextRequest } from "next/server";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { withIdempotency } from "@/lib/api/idempotency";
import { appendAlertLifecycle, alertRowOrThrow } from "@/lib/data/alerts";
import { getSingletonDb } from "@/lib/db-singleton";
import { getSingletonRedis } from "@/lib/redis-singleton";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/alerts/{id}/acknowledge (api-contracts.md §1) — coordinator+.
 * Raised → acknowledged; recorded as a user_action event on the alert aggregate.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    return await withIdempotency(request, async () => {
      const session = await requireSession("coordinator");
      const { id } = await context.params;
      const alert = await alertRowOrThrow(await getSingletonDb(), id);
      await appendAlertLifecycle({
        db: await getSingletonDb(),
        redis: await getSingletonRedis(),
        alert,
        kind: "acknowledged",
        actorEmail: session.email,
      });
      return jsonResponse({ alertId: id, status: "acknowledged" });
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
