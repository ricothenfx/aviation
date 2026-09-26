import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { scenarioInjectRequestSchema } from "@aviation/contracts";

import { flights, pnr, pnrSegments } from "@/db/schema";
import { appendAuditEvent, appendEvent } from "@/lib/data/events";
import { errorResponse, handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { getSingletonDb } from "@/lib/db-singleton";
import { withIdempotency } from "@/lib/api/idempotency";
import { loadPolicy } from "@/lib/seed/fixture-schema";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/scenario/inject (rebook-ai api-contracts.md §1) — supervisor
 * only, demo console (architecture.md §3.1). Appends `flight.disrupted` to
 * the event log (queue of record) and lets the orchestrator run the offer
 * pipeline. The flight row transition itself is applied by the orchestrator
 * handler so the event stays the single origin of the disruption.
 */

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    const session = await requireSession("supervisor");
    const body = scenarioInjectRequestSchema.parse(await request.json().catch(() => ({})));

    return await withIdempotency(request, {}, async () => {
      const db = getSingletonDb();
      const [flight] = await db
        .select()
        .from(flights)
        .where(eq(flights.flightNo, body.flightNo))
        .limit(1);
      if (!flight) {
        return errorResponse("NOT_FOUND", `unknown flight ${body.flightNo}`, { requestId });
      }
      if (flight.status !== "scheduled") {
        return errorResponse("VALIDATION_ERROR", `flight ${body.flightNo} is already disrupted`, {
          requestId,
        });
      }

      // Affected PNRs counted at inject (honest count in the event payload).
      const affected = await db
        .selectDistinct({ pnrId: pnr.id })
        .from(pnrSegments)
        .innerJoin(pnr, eq(pnrSegments.pnrId, pnr.id))
        .where(eq(pnrSegments.flightNo, body.flightNo));

      const disruptionKind = body.scenario === "long-delay" ? "long_delay" : "cancellation";
      const delayMinutes =
        disruptionKind === "long_delay" ? loadPolicy().disruption.longDelayMinutes : 0;
      const reasonCode = disruptionKind === "cancellation" ? "SIM-CANCEL-01" : "SIM-DELAY-01";

      const appended = await appendEvent({
        type: "flight.disrupted",
        aggregateType: "flight",
        aggregateId: flight.id,
        payload: {
          flightNo: body.flightNo,
          disruptionKind,
          delayMinutes,
          reasonCode,
          affectedPnrs: affected.length,
        },
      });

      await appendAuditEvent({
        actorId: session.sub,
        actorRole: session.role,
        action: "scenario.injected",
        targetType: "flight",
        targetId: body.flightNo,
        details: { eventId: appended.eventId, disruptionKind, delayMinutes },
      });

      return jsonResponse(
        {
          eventId: appended.eventId,
          flightNo: body.flightNo,
          disruptionKind,
          affectedPnrs: affected.length,
          delayMinutes: disruptionKind === "long_delay" ? delayMinutes : null,
        },
        201,
      );
    });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
