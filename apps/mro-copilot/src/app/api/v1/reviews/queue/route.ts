import type { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { answers } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { reviewQueueResponseSchema } from "@/lib/api/schemas";
import {
  ApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";
import { loadAnswerDetails } from "@/lib/answers";

/**
 * GET /api/v1/reviews/queue (api-contracts.md §1, PRD US-6/F-4): pending
 * drafts for the reviewer workspace, newest first, cursor-paginated.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const queueQuerySchema = z.object({ cursor: z.string().optional() });

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
    const query = queueQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const offset = decodeCursor(query.cursor);
    const db = getSingletonDb();

    const rows = await db
      .select({ id: answers.id })
      .from(answers)
      .where(eq(answers.status, "draft"))
      .orderBy(desc(answers.createdAt))
      .limit(PAGE_SIZE + 1)
      .offset(offset);

    const page = rows.slice(0, PAGE_SIZE);
    const details = await loadAnswerDetails(page.map((r) => r.id));
    const nextCursor = rows.length > PAGE_SIZE ? encodeCursor(offset + PAGE_SIZE) : null;

    const body = reviewQueueResponseSchema.parse({ queue: details, nextCursor });
    return jsonResponse(body);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
