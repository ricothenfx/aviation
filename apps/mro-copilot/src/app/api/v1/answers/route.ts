import type { NextRequest } from "next/server";
import { desc, eq, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { answers } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { answersResponseSchema } from "@/lib/api/schemas";
import {
  ApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
  type Session,
} from "@/lib/api/respond";
import { loadAnswerDetails, toSummary } from "@/lib/answers";

/**
 * GET /api/v1/answers (api-contracts.md §1, PRD FR-15): the verified-answer
 * library plus lifecycle visibility — viewer sees approved only; engineer
 * adds their own drafts/refusals/rejections; reviewer sees everything.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const listQuerySchema = z.object({
  status: z.enum(["draft", "refused", "approved", "rejected"]).optional(),
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

/** Nothing matches this predicate — used when a role may not see a filter. */
const MATCH_NOTHING: SQL = sql`false`;

/** Visibility scope per role (architecture.md §5, FR-15). */
function visibilityScope(session: Session, status: string | undefined): SQL | undefined {
  const own = eq(answers.createdBy, session.sub);
  const approved = eq(answers.status, "approved");
  if (status) {
    const filtered = eq(answers.status, status as "draft" | "refused" | "approved" | "rejected");
    if (session.role === "viewer") {
      return status === "approved" ? filtered : MATCH_NOTHING;
    }
    return status === "approved" ? filtered : or(filtered, own);
  }
  return session.role === "viewer" ? approved : or(approved, own);
}

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const session = await requireSession("viewer");
    const query = listQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const offset = decodeCursor(query.cursor);
    const db = getSingletonDb();

    const scope = visibilityScope(session, query.status);
    const rows = await db
      .select({ id: answers.id })
      .from(answers)
      .where(scope)
      .orderBy(desc(answers.createdAt))
      .limit(PAGE_SIZE + 1)
      .offset(offset);

    const page = rows.slice(0, PAGE_SIZE);
    const details = await loadAnswerDetails(page.map((r) => r.id));
    const nextCursor = rows.length > PAGE_SIZE ? encodeCursor(offset + PAGE_SIZE) : null;

    const body = answersResponseSchema.parse({
      answers: details.map(toSummary),
      nextCursor,
    });
    return jsonResponse(body);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
