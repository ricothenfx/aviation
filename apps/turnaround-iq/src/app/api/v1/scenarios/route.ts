import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { listScenarios } from "@/lib/data/scenarios";
import { getSingletonRedis } from "@/lib/redis-singleton";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/scenarios (api-contracts.md §1) — scripted scenarios + status.
 * Supervisor only (PRD F-7: scenario control is a supervisor job).
 */
export async function GET() {
  try {
    await requireSession("supervisor");
    const scenarios = await listScenarios(await getSingletonRedis());
    return jsonResponse(scenarios);
  } catch (err) {
    return handleRouteError(err);
  }
}
