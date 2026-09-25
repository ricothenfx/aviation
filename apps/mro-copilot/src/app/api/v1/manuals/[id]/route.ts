import { eq, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { manualDetailSchema } from "@/lib/api/schemas";
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
 * GET /api/v1/manuals/{id} (api-contracts.md §1): manual metadata + the full
 * section tree derived from chunk section paths (TOC for the browser UI).
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = newRequestId();
  try {
    await requireSession("viewer");
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) {
      throw new ApiError("NOT_FOUND", "manual not found");
    }
    const db = getSingletonDb();

    const manual = (await db.select().from(manuals).where(eq(manuals.id, id)).limit(1))[0];
    if (!manual) {
      throw new ApiError("NOT_FOUND", "manual not found");
    }

    const rows = await db
      .select({
        sectionPath: chunks.sectionPath,
        page: sql<number>`(array_agg(${chunks.page} order by ${chunks.chunkIndex}))[1]`.mapWith(
          Number,
        ),
        chunkCount: sql<number>`count(*)`.mapWith(Number),
        firstIndex: sql<number>`min(${chunks.chunkIndex})`.mapWith(Number),
      })
      .from(chunks)
      .where(eq(chunks.manualId, id))
      .groupBy(chunks.sectionPath)
      .orderBy(sql`min(${chunks.chunkIndex}) asc`);

    const breadcrumb = manualBreadcrumb(manual.docType, manual.ataChapter, manual.taskNo, manual.revision, manual.title);
    const sections = rows.map((row) => {
      const suffix = row.sectionPath.startsWith(`${breadcrumb} · `)
        ? row.sectionPath.slice(breadcrumb.length + 3)
        : row.sectionPath;
      return {
        path: row.sectionPath,
        label: suffix,
        depth: suffix.split(" · ").length,
        page: row.page,
        chunkCount: row.chunkCount,
      };
    });

    const body = manualDetailSchema.parse({
      manual: {
        id: manual.id,
        docType: manual.docType,
        title: manual.title,
        ataChapter: manual.ataChapter,
        taskNo: manual.taskNo,
        revision: manual.revision,
        effectiveDate: manual.effectiveDate,
        status: manual.status,
      },
      breadcrumb,
      sections,
      chunkCount: sections.reduce((sum, s) => sum + s.chunkCount, 0),
    });
    return jsonResponse(body);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}

/**
 * Reconstruct the canonical breadcrumb exactly as the ingest pipeline wrote it
 * into chunk section paths (mro_ai/corpus.py ManualMeta.breadcrumb).
 */
function manualBreadcrumb(
  docType: string,
  ataChapter: string,
  taskNo: string | null,
  revision: string,
  title: string,
): string {
  const prefix = `NX320 ${docType} · ATA ${ataChapter} · `;
  if (docType === "AMM" || docType === "TSM") {
    const task = taskNo ?? "";
    const group = task.split("-").slice(0, 3).join("-");
    return `${prefix}${group} · Task ${task} · ${title}`;
  }
  if (docType === "IPC") {
    return `${prefix}Figure ${taskNo} · ${title}`;
  }
  return `${prefix}${taskNo} · ${revision} · ${title}`;
}
