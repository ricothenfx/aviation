import { z } from "zod";

import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";

/**
 * GET /api/v1/queue (rebook-ai api-contracts.md §1) — live agent queue
 * snapshot, priority-sorted. F1 contract slice: shape is final, items arrive
 * with F2 (data-model.md §3 Redis ZSET projection). `containmentPct: null` is
 * the honest "not measurable yet" value (D-15 precedent: never 0-for-no-data).
 */
const queueSchema = z.object({
  items: z.array(z.never()),
  containmentPct: z.number().nullable(),
});

export async function GET(): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    await requireSession("agent");
    const queue = queueSchema.parse({ items: [], containmentPct: null });
    return jsonResponse({ ...queue, generatedAt: new Date().toISOString() });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
