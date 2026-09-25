import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { docTypeSchema, manualsResponseSchema } from "@/lib/api/schemas";
import {
  ApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";
import { getSingletonDb } from "@/lib/db-singleton";
import { chunks, manuals } from "@/db/schema";
import { z } from "zod";

/**
 * GET /api/v1/manuals (api-contracts.md §1, PRD US-1/F-1).
 * Manual list with TOC summary. Filters: docType, ataChapter, status.
 * Cursor pagination (opaque offset — a small reference list per
 * engineering-standards.md §4).
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const listQuerySchema = z.object({
  docType: docTypeSchema.optional(),
  ataChapter: z
    .string()
    .regex(/^\d{1,3}$/)
    .optional(),
  status: z.enum(["active", "superseded"]).optional(),
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
    await requireSession("viewer");
    const query = listQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const offset = decodeCursor(query.cursor);
    const db = getSingletonDb();

    const conditions: SQL[] = [];
    if (query.docType) conditions.push(eq(manuals.docType, query.docType));
    if (query.ataChapter) conditions.push(eq(manuals.ataChapter, query.ataChapter));
    if (query.status) conditions.push(eq(manuals.status, query.status));

    const rows = await db
      .select({
        id: manuals.id,
        docType: manuals.docType,
        title: manuals.title,
        ataChapter: manuals.ataChapter,
        taskNo: manuals.taskNo,
        revision: manuals.revision,
        effectiveDate: manuals.effectiveDate,
        status: manuals.status,
        chunkCount:
          sql<number>`(select count(*) from ${chunks} where ${chunks.manualId} = ${manuals.id})`.mapWith(
            Number,
          ),
      })
      .from(manuals)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(manuals.docType), asc(manuals.ataChapter), asc(manuals.taskNo))
      .limit(PAGE_SIZE + 1)
      .offset(offset);

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    // TOC summary across the whole library (nav facet, unaffected by filters)
    const tocRows = await db
      .select({
        docType: manuals.docType,
        chapter: manuals.ataChapter,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(manuals)
      .groupBy(manuals.docType, manuals.ataChapter)
      .orderBy(asc(manuals.docType), asc(manuals.ataChapter));

    const tocMap = new Map<string, { chapter: string; count: number }[]>();
    for (const row of tocRows) {
      const list = tocMap.get(row.docType) ?? [];
      list.push({ chapter: row.chapter, count: row.count });
      tocMap.set(row.docType, list);
    }
    const toc = [...tocMap.entries()].map(([docType, chapters]) => ({ docType, chapters }));

    const body = manualsResponseSchema.parse({
      manuals: page,
      toc,
      nextCursor: hasMore ? encodeCursor(offset + PAGE_SIZE) : null,
    });
    return jsonResponse(body);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
