import type { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";

import { poisonEventViewSchema } from "@aviation/contracts";
import { handleRouteError, jsonResponse, requireSession } from "@/lib/api/respond";
import { getSingletonDb } from "@/lib/db-singleton";
import { eventLog } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/events (rebook-ai api-contracts.md §1, additive F2) —
 * supervisor view of poison events: processed=false rows with their error
 * notes and attempt counts. Poison events are surfaced, never silently
 * dropped (architecture.md §6, engineering-standards.md §6).
 */
export async function GET(_request: NextRequest): Promise<Response> {
  const requestId = `req_${crypto.randomUUID()}`;
  try {
    await requireSession("supervisor");
    const db = getSingletonDb();

    // Poison view: only rows that FAILED at least one attempt qualify —
    // merely-unprocessed events may still be waiting for the tail.
    const rows = await db
      .select({
        id: eventLog.id,
        type: eventLog.type,
        aggregateType: eventLog.aggregateType,
        aggregateId: eventLog.aggregateId,
        occurredAt: eventLog.occurredAt,
        attempts: eventLog.attempts,
        processError: eventLog.processError,
      })
      .from(eventLog)
      .where(eq(eventLog.processed, false))
      .orderBy(desc(eventLog.id))
      .limit(100);

    const poison = rows
      .filter((row) => row.processError !== null && row.attempts > 0)
      .slice(0, 50)
      .map((row) =>
        poisonEventViewSchema.parse({
          id: row.id,
          type: row.type,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          occurredAt: row.occurredAt.toISOString(),
          attempts: row.attempts,
          processError: row.processError ?? "unknown error",
        }),
      );

    return jsonResponse({ events: poison });
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
