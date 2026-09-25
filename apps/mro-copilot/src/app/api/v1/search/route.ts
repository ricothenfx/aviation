import type { NextRequest } from "next/server";

import { searchQuerySchema, searchResponseSchema, type SearchResponse } from "@/lib/api/schemas";
import { handleRouteError, jsonResponse, newRequestId, requireSession } from "@/lib/api/respond";
import { retrievalSearch } from "@/lib/ai/client";
import { logger } from "@/lib/logger";

/**
 * GET /api/v1/search (api-contracts.md §1, PRD FR-7/FR-8).
 * Hybrid retrieval via the ai-service; `mode` flags degraded retrieval
 * (lexical) so clients can surface it honestly (architecture.md §4).
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = newRequestId();
  try {
    await requireSession("viewer");
    const raw = Object.fromEntries(request.nextUrl.searchParams);
    const query = searchQuerySchema.parse(raw);
    const started = Date.now();
    const retrieval = await retrievalSearch(
      {
        query: query.q,
        k: query.limit,
        docTypes: query.docType ? [query.docType] : undefined,
        ataChapters: query.ataChapter ? [query.ataChapter] : undefined,
        revision: query.revision,
      },
      requestId,
    );
    const body = searchResponseSchema.parse({
      mode: retrieval.mode,
      results: retrieval.results,
      latencyMs: retrieval.latencyMs,
    }) satisfies SearchResponse;
    logger.info({
      msg: "search_completed",
      requestId,
      mode: body.mode,
      results: body.results.length,
      retrievalMs: body.latencyMs,
      totalMs: Date.now() - started,
    });
    return jsonResponse(body);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
