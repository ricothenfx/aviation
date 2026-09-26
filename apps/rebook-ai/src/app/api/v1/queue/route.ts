import { getSingletonRedis } from "@/lib/redis-singleton";
import { readQueueSnapshot } from "@/lib/data/queue";
import { queueSnapshotViewSchema } from "@aviation/contracts";
import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/queue (rebook-ai api-contracts.md §1) — live agent queue
 * snapshot (agent+), priority-sorted by the Redis projection with PG-backed
 * details and containment metric. Missing projection ⇒ rebuild via the
 * control channel (data-model.md §3, architecture.md §4).
 */
export async function GET(): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    await requireSession("agent");
    const { publisher } = await getSingletonRedis();
    const queue = queueSnapshotViewSchema.parse(await readQueueSnapshot(publisher));
    return jsonResponse(queue);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
