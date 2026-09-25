import { desc, eq } from "drizzle-orm";

import { engineAlerts } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { engineAlertsResponseSchema } from "@/lib/api/schemas";
import { ALERT_STATES } from "@/lib/api/schemas";
import {
  MroApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";
import { alertToApi, userNameMap } from "@/lib/engines/serialize";

/**
 * GET /api/v1/engines/alerts (api-contracts.md §1): maintenance-window
 * alerts, newest first, optional `status` filter (raised | acknowledged |
 * resolved). Provenance on every alert (api-contracts.md §4).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = newRequestId();
  try {
    await requireSession("viewer");
    const statusParam = new URL(request.url).searchParams.get("status");
    const status =
      statusParam !== null && (ALERT_STATES as readonly string[]).includes(statusParam)
        ? (statusParam as (typeof ALERT_STATES)[number])
        : null;
    if (statusParam !== null && status === null) {
      throw new MroApiError(
        "VALIDATION_ERROR",
        "status must be one of raised | acknowledged | resolved",
      );
    }

    const db = getSingletonDb();
    const base = db.select().from(engineAlerts).$dynamic();
    const rows = await (status ? base.where(eq(engineAlerts.state, status)) : base).orderBy(
      desc(engineAlerts.raisedAt),
    );
    const names = await userNameMap();

    return jsonResponse(
      engineAlertsResponseSchema.parse({ alerts: rows.map((a) => alertToApi(a, names)) }),
    );
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
