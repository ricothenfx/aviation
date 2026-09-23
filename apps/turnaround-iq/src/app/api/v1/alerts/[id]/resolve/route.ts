import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { withIdempotency } from "@/lib/api/idempotency";
import { appendAlertLifecycle, alertRowOrThrow } from "@/lib/data/alerts";
import { getSingletonDb } from "@/lib/db-singleton";
import { getSingletonRedis } from "@/lib/redis-singleton";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ note: z.string().max(500).optional() });

/**
 * POST /api/v1/alerts/{id}/resolve {note} (api-contracts.md §1) — coordinator+.
 * → resolved; the note rides the event payload for the audit trail.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    return await withIdempotency(request, async () => {
      const session = await requireSession("coordinator");
      const { id } = await context.params;
      const body = bodySchema.parse(await request.json().catch(() => ({})));
      const alert = await alertRowOrThrow(await getSingletonDb(), id);
      await appendAlertLifecycle({
        db: await getSingletonDb(),
        redis: await getSingletonRedis(),
        alert,
        kind: "resolved",
        actorEmail: session.email,
        note: body.note,
      });
      return jsonResponse({ alertId: id, status: "resolved" });
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
