import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { sagaCompensateResponseSchema } from "@aviation/contracts";

import { sagas } from "@/db/schema";
import { requestOrchestrator } from "@/lib/api/control";
import { withIdempotency } from "@/lib/api/idempotency";
import { handleRouteError, jsonResponse, requireSession, ApiError } from "@/lib/api/respond";
import { appendAuditEvent } from "@/lib/data/events";
import { getSingletonDb } from "@/lib/db-singleton";

export const dynamic = "force-dynamic";

const COMPENSATE_WAIT_MS = 10_000;

/**
 * POST /api/v1/sagas/{id}/compensate (api-contracts.md §1) — supervisor-only
 * manual compensation after a failure (audited). The web app commands the
 * orchestrator over the control channel; the executor unwinds from persisted
 * step state in reverse order and the passenger returns to the queue
 * honestly (architecture.md §3.2/§6).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sagaId: string }> },
): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const session = await requireSession("supervisor");
    const { sagaId } = await context.params;

    return await withIdempotency(request, {}, async () => {
      const db = getSingletonDb();
      const [saga] = await db
        .select({ id: sagas.id, state: sagas.state })
        .from(sagas)
        .where(eq(sagas.id, sagaId))
        .limit(1);
      if (!saga) throw new ApiError("NOT_FOUND", "saga not found");
      if (saga.state === "completed" || saga.state === "compensated") {
        throw new ApiError(
          "SAGA_CONFLICT",
          `saga is already ${saga.state} — manual compensation only applies to running or failed sagas`,
        );
      }

      const outcome = await requestOrchestrator<{ state?: string }>(
        "saga.compensate",
        { sagaId },
        COMPENSATE_WAIT_MS,
      );
      if (outcome.kind === "error") {
        throw new ApiError("INTERNAL", `compensation failed: ${outcome.message}`);
      }

      let state = outcome.kind === "ok" ? (outcome.result.state ?? "compensated") : null;
      if (!state || outcome.kind === "timeout") {
        // Executor may still be unwinding — report the persisted truth now.
        const [fresh] = await db
          .select({ state: sagas.state })
          .from(sagas)
          .where(eq(sagas.id, sagaId))
          .limit(1);
        state = fresh?.state ?? "running";
      }

      await appendAuditEvent({
        actorId: session.sub,
        actorRole: session.role,
        action: "saga.compensated",
        targetType: "saga",
        targetId: sagaId,
        details: { requestedFrom: "supervisor console", resultState: state },
      });

      return jsonResponse(sagaCompensateResponseSchema.parse({ sagaId, state }));
    });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
