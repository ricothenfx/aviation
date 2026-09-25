import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

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

/**
 * POST /api/v1/engines/alerts/{id}/acknowledge (api-contracts.md §1, FR-17):
 * `raised → acknowledged`, engineer+ (viewer blocked server-side; reviewer
 * allowed via the role ladder). Acknowledging an already-acknowledged or
 * resolved alert is 409 LIFECYCLE_CONFLICT. Audit-recorded, append-only.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = newRequestId();
  try {
    const session = await requireSession("engineer");
    const { id } = await context.params;

    return await withIdempotency(request, async () => {
      const db = getSingletonDb();
      const rows = await db.select().from(engineAlerts).where(eq(engineAlerts.id, id)).limit(1);
      const alert = rows[0];
      if (!alert) throw new MroApiError("NOT_FOUND", `alert ${id} not found`);
      if (alert.state !== "raised") {
        throw new MroApiError("LIFECYCLE_CONFLICT", `alert is ${alert.state}, not raised`);
      }

      const at = new Date();
      await db
        .update(engineAlerts)
        .set({ state: "acknowledged", acknowledgedAt: at, acknowledgedBy: session.sub })
        .where(eq(engineAlerts.id, id));

      await recordAudit({
        eventType: "alert.acknowledged",
        alertId: id,
        actorId: session.sub,
        payload: { unitId: alert.unitId, engineerName: session.name, at: at.toISOString() },
      });

      const updated = await db.select().from(engineAlerts).where(eq(engineAlerts.id, id)).limit(1);
      const names = await userNameMap();
      return jsonResponse(engineAlertSchema.parse(alertToApi(updated[0]!, names)));
    });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
