import type { NextRequest } from "next/server";
import { desc } from "drizzle-orm";
import { z } from "zod";

import { ingestRuns } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { ingestRunsResponseSchema } from "@/lib/api/schemas";
import {
  ApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";

/**
 * GET /api/v1/admin/ingest/runs (api-contracts.md §1 Admin/Ingest, PRD US-10):
 * reviewer+ ingest run history — the evidence backing the FR-5 idempotency
 * claim (corpus digest + new/changed/unchanged/removed per run). Rows are
 * written by the ai-service inside the ingest transaction.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const listQuerySchema = z.object({
  cursor: z.string().optional(),
});

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10);
  if (!Number.isFinite(offset) || offset < 0) {
    throw new ApiError("VALIDATION_ERROR", "invalid cursor");
  }
  return offset;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64");
}

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    await requireSession("reviewer");
    const query = listQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const offset = decodeCursor(query.cursor);
    const db = getSingletonDb();

    const rows = await db
      .select()
      .from(ingestRuns)
      .orderBy(desc(ingestRuns.createdAt))
      .limit(PAGE_SIZE + 1)
      .offset(offset);

    const page = rows.slice(0, PAGE_SIZE);
    const nextCursor = rows.length > PAGE_SIZE ? encodeCursor(offset + PAGE_SIZE) : null;

    const body = ingestRunsResponseSchema.parse({
      runs: page.map((row) => ({
        runId: row.id,
        corpusDigest: row.corpusDigest,
        embeddingModel: row.embeddingModel,
        manualsTouched: row.manualsTouched,
        chunksNew: row.chunksNew,
        chunksChanged: row.chunksChanged,
        chunksUnchanged: row.chunksUnchanged,
        chunksRemoved: row.chunksRemoved,
        durationMs: row.durationMs,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor,
    });
    return jsonResponse(body);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
