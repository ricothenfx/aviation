import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { chunkDetailResponseSchema } from "@/lib/api/schemas";
import {
  ApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";
import { getSingletonDb } from "@/lib/db-singleton";
import { chunks, manuals } from "@/db/schema";

/**
 * GET /api/v1/manuals/{id}/chunks/{chunkId} (api-contracts.md §1, PRD FR-6):
 * one chunk with full provenance — breadcrumb, fictional page, revision and
 * effective date — plus prev/next navigation inside the same manual.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; chunkId: string }> },
) {
  const requestId = newRequestId();
  try {
    await requireSession("viewer");
    const { id, chunkId } = await params;
    const ids = z.object({ id: z.string().uuid(), chunkId: z.string().uuid() });
    const parsed = ids.safeParse({ id, chunkId });
    if (!parsed.success) {
      throw new ApiError("NOT_FOUND", "chunk not found");
    }
    const db = getSingletonDb();

    const rows = await db
      .select({ chunk: chunks, manual: manuals })
      .from(chunks)
      .innerJoin(manuals, eq(manuals.id, chunks.manualId))
      .where(and(eq(chunks.id, chunkId), eq(chunks.manualId, id)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new ApiError("NOT_FOUND", "chunk not found");
    }

    const neighbours = await db
      .select({ id: chunks.id, chunkIndex: chunks.chunkIndex })
      .from(chunks)
      .where(eq(chunks.manualId, id))
      .orderBy(chunks.chunkIndex);
    const position = neighbours.findIndex((n) => n.id === chunkId);

    const body = chunkDetailResponseSchema.parse({
      chunk: {
        id: row.chunk.id,
        manualId: row.chunk.manualId,
        docType: row.manual.docType,
        taskNo: row.manual.taskNo,
        ataChapter: row.manual.ataChapter,
        title: row.manual.title,
        revision: row.manual.revision,
        effectiveDate: row.manual.effectiveDate,
        status: row.manual.status,
        sectionPath: row.chunk.sectionPath,
        page: row.chunk.page,
        chunkIndex: row.chunk.chunkIndex,
        content: row.chunk.content,
        tokenCount: row.chunk.tokenCount,
      },
      navigation: {
        prevChunkId: position > 0 ? neighbours[position - 1]!.id : null,
        nextChunkId:
          position >= 0 && position < neighbours.length - 1
            ? neighbours[position + 1]!.id
            : null,
      },
    });
    return jsonResponse(body);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
