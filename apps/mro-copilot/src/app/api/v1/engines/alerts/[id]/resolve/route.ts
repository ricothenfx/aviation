import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { engineAlerts } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { engineAlertSchema } from "@/lib/api/schemas";
import {
  MroApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";
import { withIdempotency } from "@/lib/api/idempotency";
import { recordAudit } from "@/lib/audit";
import { alertToApi, userNameMap } from "@/lib/engines/serialize";

const resolveRequestSchema = z.object({
  note: z.string().trim().min(3).max(2_000),
});

/**
 * POST /api/v1/engines/alerts/{id}/resolve (api-contracts.md §1, FR-17):
 * `acknowledged → resolved` with a MANDATORY note, engineer+. Strict chain:
 * resolving a raised (unacknowledged) or resolved alert is 409
 * LIFECYCLE_CONFLICT. Audit-recorded, append-only.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const session = await requireSession("engineer");
    const { id } = await context.params;
    const body = resolveRequestSchema.parse(await request.json());

    return await withIdempotency(request, async () => {
      const db = getSingletonDb();
      const rows = await db.select().from(engineAlerts).where(eq(engineAlerts.id, id)).limit(1);
      const alert = rows[0];
      if (!alert) throw new MroApiError("NOT_FOUND", `alert ${id} not found`);
      if (alert.state !== "acknowledged") {
        throw new MroApiError(
          "LIFECYCLE_CONFLICT",
          `alert is ${alert.state}, not acknowledged — resolve follows acknowledge`,
        );
      }

      const at = new Date();
      await db
        .update(engineAlerts)
        .set({
          state: "resolved",
          resolvedAt: at,
          resolvedBy: session.sub,
          resolveNote: body.note,
        })
        .where(eq(engineAlerts.id, id));

      await recordAudit({
        eventType: "alert.resolved",
        alertId: id,
        actorId: session.sub,
        payload: {
          unitId: alert.unitId,
          engineerName: session.name,
          note: body.note,
          at: at.toISOString(),
        },
      });

      const updated = await db.select().from(engineAlerts).where(eq(engineAlerts.id, id)).limit(1);
      const names = await userNameMap();
      return jsonResponse(engineAlertSchema.parse(alertToApi(updated[0]!, names)));
    });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
