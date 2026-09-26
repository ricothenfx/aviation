import type { NextRequest } from "next/server";

import { ingestReportSchema } from "@/lib/ai/contract";
import { triggerIngest } from "@/lib/ai/client";
import { handleRouteError, jsonResponse, newRequestId, requireSession } from "@/lib/api/respond";
import { withIdempotency } from "@/lib/api/idempotency";
import { recordAudit } from "@/lib/audit";

/**
 * POST /api/v1/admin/ingest (api-contracts.md §1 Admin/Ingest, PRD US-10).
 * Completes the §1 contract deferred from F3/F4 (milestone-report-f3/f4 §
 * Deviations; treated as in-scope for F5 per the milestone-report doc-gap
 * note — the ai-service ingest machinery already existed since F2).
 *
 * Reviewer+ only. The job itself runs inside the ai-service (same code path
 * as `python -m mro_ai.ingest`, ADR-0012) and is idempotent by chunk content
 * hash (FR-5); a concurrent run is 409 INGEST_IN_PROGRESS. Mutating ⇒
 * Idempotency-Key replay supported (FR-2). The ai-service persists the
 * ingest_runs row; this route appends the append-only audit event.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const session = await requireSession("reviewer");
    const report = await withIdempotency(request, async () => {
      const parsed = ingestReportSchema.parse(await triggerIngest(requestId));
      return jsonResponse(parsed);
    });

    // Audit records each trigger attempt (a replay IS an attempt); the report
    // body itself (with the authoritative corpus digest) lives in ingest_runs —
    // append-only discipline: audit says who did what, ingest_runs the what.
    await recordAudit({
      eventType: "ingest.triggered",
      answerId: null,
      actorId: session.sub,
      payload: { requestId },
    });
    return report;
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
