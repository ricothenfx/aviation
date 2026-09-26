import { handleRouteError, requireSession } from "@/lib/api/respond";
import { streamLive } from "@/lib/live/sse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/live (rebook-ai api-contracts.md §3, additive F2) — SSE bridge
 * from `chan:rb:live` to the browser. Passenger streams are scoped to their
 * own PNRs (ownership, architecture.md §5); agent+ streams also receive
 * queue.delta. Clients resync from the REST snapshots.
 */
export async function GET(): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const session = await requireSession("passenger");
    return await streamLive(session, (msg, fields) =>
      console.info(JSON.stringify({ level: "info", module: "sse", requestId, msg, ...fields })),
    );
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
