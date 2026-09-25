import type { NextRequest } from "next/server";
import { inArray } from "drizzle-orm";
import { LlmGateway, ProviderUnavailableError, type CompletionResult } from "@aviation/llm-gateway";

import { answers, answerCitations, chunks } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { logger } from "@/lib/logger";
import { askRequestSchema, askResponseSchema, type Citation } from "@/lib/api/schemas";
import { handleRouteError, jsonResponse, newRequestId, requireSession } from "@/lib/api/respond";
import { withIdempotency } from "@/lib/api/idempotency";
import { retrievalSearch } from "@/lib/ai/client";
import { recordAudit } from "@/lib/audit";
import { RAG_CONFIG } from "@/lib/rag/config";
import {
  buildRagMessages,
  checkCitations,
  extractiveAnswerText,
  groundingScoreFor,
  isBelowGroundingThreshold,
  stripCitationMarkers,
  type RagBlock,
  type RefusalReason,
} from "@/lib/rag/engine";

/**
 * POST /api/v1/ask — the RAG loop (api-contracts.md §1, architecture.md §3,
 * PRD FR-9..FR-13): RBAC engineer+ → hybrid retrieval (top-k=8) → guardrail
 * pre-check (refuse below the calibrated grounding threshold WITHOUT calling
 * the LLM) → prompt assembly → packages/llm-gateway (mock provider default)
 * → citation post-check (hallucinated markers stripped; zero valid ⇒ refusal)
 * → persisted draft + citations + append-only audit. Provider unavailable ⇒
 * extractive fallback labeled `source: "extractive"` (FR-12, ADR-0003).
 * Refusal is a valid 200 outcome — never an error envelope.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const session = await requireSession("engineer");
    const body = askRequestSchema.parse(await request.json());

    return await withIdempotency(request, () => runAsk(body.question, session.sub, requestId));
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}

async function runAsk(question: string, userId: string, requestId: string) {
  const db = getSingletonDb();
  const started = Date.now();

  // 1. Retrieval (ai-service, ADR-0012). Response names its mode.
  const retrieval = await retrievalSearch(
    { query: question, k: RAG_CONFIG.RETRIEVAL_K },
    requestId,
  );
  const hits = retrieval.results;
  const groundingScore = groundingScoreFor(retrieval.mode, hits);
  const retrievalMeta = {
    mode: retrieval.mode,
    topK: RAG_CONFIG.RETRIEVAL_K,
    latencyMs: retrieval.latencyMs,
  };
  logger.info({
    msg: "ask_stage_retrieval",
    requestId,
    mode: retrieval.mode,
    hits: hits.length,
    groundingScore: Number(groundingScore.toFixed(4)),
    retrievalMs: retrieval.latencyMs,
  });

  // 2. Guardrail pre-check: refuse without calling the LLM (FR-10).
  if (hits.length === 0 || isBelowGroundingThreshold(retrieval.mode, groundingScore)) {
    return persistAndRespond({
      question,
      userId,
      status: "refused",
      refusalReason: "below_grounding_threshold",
      source: "none",
      provider: "none",
      groundingScore,
      retrievalMeta,
      totalMs: Date.now() - started,
    });
  }

  // 3. Hydrate full chunk contents for the context blocks (the retrieval
  //    snippets are search-UX headlines; prompting grounds on full content).
  const contents = await db
    .select({ id: chunks.id, content: chunks.content })
    .from(chunks)
    .where(
      inArray(
        chunks.id,
        hits.map((h) => h.chunkId),
      ),
    );
  const contentById = new Map(contents.map((c) => [c.id, c.content]));
  const blocks: RagBlock[] = hits.map((hit, i) => ({
    index: i + 1,
    hit,
    content: contentById.get(hit.chunkId) ?? hit.snippet,
  }));

  // 4. LLM completion via the provider-agnostic gateway (ADR-0003/0012);
  //    any provider unavailability degrades to the extractive fallback.
  let completion: CompletionResult | null = null;
  try {
    const gateway = LlmGateway.fromEnv();
    const llmStarted = Date.now();
    completion = await gateway.complete({
      messages: buildRagMessages(question, blocks),
      temperature: 0,
      maxTokens: 700,
    });
    logger.info({
      msg: "ask_stage_llm",
      requestId,
      provider: completion.provider,
      llmMs: Date.now() - llmStarted,
    });
  } catch (err) {
    if (!(err instanceof ProviderUnavailableError)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ msg: "ask_llm_unavailable_extractive_fallback", requestId, err: message });
  }

  if (completion === null) {
    // 5a. Extractive fallback (FR-12): verbatim top chunks, labeled honestly.
    return persistAndRespond({
      question,
      userId,
      status: "draft",
      source: "extractive",
      provider: "none",
      groundingScore,
      retrievalMeta,
      totalMs: Date.now() - started,
      answerText: extractiveAnswerText(blocks),
      citations: blocks.slice(0, RAG_CONFIG.EXTRACTIVE_TOP_CHUNKS).map(citationFromBlock),
    });
  }

  // 5b. Citation post-check (FR-11): strip hallucinated markers; an answer
  //     whose markers are ALL invalid downgrades to a refusal — never emit
  //     uncited procedural content (architecture.md §3 step 5).
  const check = checkCitations(completion.text, blocks.length);
  if (check.valid.length === 0) {
    return persistAndRespond({
      question,
      userId,
      status: "refused",
      refusalReason: "no_valid_citations",
      source: completion.text.trim().length > 0 ? "llm" : "none",
      provider: completion.provider,
      groundingScore,
      retrievalMeta,
      totalMs: Date.now() - started,
      tokenUsage: completion.usage,
    });
  }
  const finalText = stripCitationMarkers(completion.text, check.invalid);
  const citations = check.valid.map((marker) => citationFromBlock(blocks[marker - 1]!));

  return persistAndRespond({
    question,
    userId,
    status: "draft",
    source: "llm",
    provider: completion.provider,
    groundingScore,
    retrievalMeta,
    totalMs: Date.now() - started,
    answerText: finalText,
    citations,
    tokenUsage: completion.usage,
  });
}

function citationFromBlock(block: RagBlock): Citation {
  return {
    chunkId: block.hit.chunkId,
    manualId: block.hit.manualId,
    docType: block.hit.docType,
    ataChapter: block.hit.ataChapter,
    taskNo: block.hit.taskNo,
    sectionPath: block.hit.sectionPath,
    page: block.hit.page,
    revision: block.hit.revision,
    snippet: block.hit.snippet,
  };
}

interface PersistArgs {
  question: string;
  userId: string;
  status: "draft" | "refused";
  refusalReason?: RefusalReason;
  source: "llm" | "extractive" | "none";
  provider: string;
  groundingScore: number;
  retrievalMeta: { mode: string; topK: number; latencyMs: number };
  totalMs: number;
  answerText?: string;
  citations?: Citation[];
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

async function persistAndRespond(args: PersistArgs) {
  const db = getSingletonDb();
  const [row] = await db
    .insert(answers)
    .values({
      question: args.question,
      answerText: args.answerText ?? null,
      status: args.status,
      refusalReason: args.refusalReason ?? null,
      source: args.source,
      provider: args.provider,
      groundingScore: args.groundingScore,
      retrievalMeta: args.retrievalMeta,
      tokenUsage: args.tokenUsage ?? null,
      latencyMs: args.totalMs,
      createdBy: args.userId,
    })
    .returning({ id: answers.id });

  if (args.citations?.length && row) {
    await db.insert(answerCitations).values(
      args.citations.map((c, seq) => ({
        answerId: row.id,
        seq,
        chunkId: c.chunkId,
        manualId: c.manualId,
        docType: c.docType,
        ataChapter: c.ataChapter,
        taskNo: c.taskNo,
        sectionPath: c.sectionPath,
        page: c.page,
        revision: c.revision,
        snippet: c.snippet,
      })),
    );
  }

  await recordAudit({
    eventType: "answer.created",
    answerId: row?.id ?? null,
    actorId: args.userId,
    payload: {
      status: args.status,
      source: args.source,
      provider: args.provider,
      refusalReason: args.refusalReason ?? null,
      groundingScore: Number(args.groundingScore.toFixed(4)),
      citationCount: args.citations?.length ?? 0,
      retrievalMode: args.retrievalMeta.mode,
    },
  });

  const payload = {
    answerId: row!.id,
    status: args.status,
    ...(args.status === "refused"
      ? { refusalReason: args.refusalReason }
      : { answer: args.answerText, citations: args.citations }),
    source: args.source,
    provider: args.provider,
    groundingScore: Number(args.groundingScore.toFixed(4)),
    retrieval: { mode: args.retrievalMeta.mode, latencyMs: args.retrievalMeta.latencyMs },
  } as const;
  const body = askResponseSchema.parse(payload);
  logger.info({
    msg: "ask_completed",
    answerId: body.answerId,
    status: body.status,
    source: body.source,
    provider: body.provider,
    totalMs: args.totalMs,
  });
  return jsonResponse(body);
}
