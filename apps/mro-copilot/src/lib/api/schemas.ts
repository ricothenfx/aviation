import { z } from "zod";

import { retrievalHitSchema, retrievalSearchResponseSchema } from "@/lib/ai/contract";

/**
 * mro-copilot REST contracts (api-contracts.md §1). Domain schemas live in the
 * app — architecture.md §2 keeps mro semantics out of packages/contracts.
 * The search response schema is the zod twin of the pydantic
 * RetrievalSearchResponse served by ai-service (see lib/ai/contract.ts);
 * both runtimes parse the committed fixture at
 * services/mro-copilot/ai-service/tests/fixtures/retrieval_contract.json.
 */

export const DOC_TYPES = ["AMM", "IPC", "TSM", "SB"] as const;
export const MANUAL_STATUSES = ["active", "superseded"] as const;

export const docTypeSchema = z.enum(DOC_TYPES);
export type DocType = z.infer<typeof docTypeSchema>;

// --- GET /api/v1/search ------------------------------------------------------

export const searchHitSchema = retrievalHitSchema;
export type SearchHit = z.infer<typeof searchHitSchema>;

/** `mode` flags degraded retrieval: hybrid | lexical (FR-7). */
export const searchResponseSchema = retrievalSearchResponseSchema;
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(2_000),
  docType: docTypeSchema.optional(),
  ataChapter: z
    .string()
    .regex(/^\d{1,3}$/)
    .optional(),
  revision: z.string().trim().min(1).max(32).optional(),
  limit: z.coerce.number().int().positive().max(20).default(10),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

// --- GET /api/v1/manuals ------------------------------------------------------

export const manualSummarySchema = z.object({
  id: z.string().uuid(),
  docType: docTypeSchema,
  title: z.string(),
  ataChapter: z.string(),
  taskNo: z.string().nullable(),
  revision: z.string(),
  effectiveDate: z.string(),
  status: z.enum(MANUAL_STATUSES),
  chunkCount: z.number().int().nonnegative(),
});
export type ManualSummary = z.infer<typeof manualSummarySchema>;

export const tocChapterSchema = z.object({
  chapter: z.string(),
  count: z.number().int().nonnegative(),
});
export type TocChapter = z.infer<typeof tocChapterSchema>;

export const tocEntrySchema = z.object({
  docType: docTypeSchema,
  chapters: z.array(tocChapterSchema),
});
export type TocEntry = z.infer<typeof tocEntrySchema>;

export const manualsResponseSchema = z.object({
  manuals: z.array(manualSummarySchema),
  toc: z.array(tocEntrySchema),
  nextCursor: z.string().nullable(),
});
export type ManualsResponse = z.infer<typeof manualsResponseSchema>;

// --- GET /api/v1/manuals/{id} -------------------------------------------------

export const manualSectionSchema = z.object({
  path: z.string(),
  label: z.string(),
  depth: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  chunkCount: z.number().int().nonnegative(),
  firstChunkId: z.string().uuid(),
});
export type ManualSection = z.infer<typeof manualSectionSchema>;

export const manualDetailSchema = z.object({
  manual: manualSummarySchema.omit({ chunkCount: true }),
  breadcrumb: z.string(),
  sections: z.array(manualSectionSchema),
  chunkCount: z.number().int().nonnegative(),
});
export type ManualDetail = z.infer<typeof manualDetailSchema>;

// --- GET /api/v1/manuals/{id}/chunks/{chunkId} ---------------------------------

export const chunkDetailSchema = z.object({
  id: z.string().uuid(),
  manualId: z.string().uuid(),
  docType: docTypeSchema,
  taskNo: z.string().nullable(),
  ataChapter: z.string(),
  title: z.string(),
  revision: z.string(),
  effectiveDate: z.string(),
  status: z.enum(MANUAL_STATUSES),
  sectionPath: z.string(),
  page: z.number().int().positive(),
  chunkIndex: z.number().int().nonnegative(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
});
export type ChunkDetail = z.infer<typeof chunkDetailSchema>;

export const chunkDetailResponseSchema = z.object({
  chunk: chunkDetailSchema,
  navigation: z.object({
    prevChunkId: z.string().uuid().nullable(),
    nextChunkId: z.string().uuid().nullable(),
  }),
});

// --- POST /api/v1/ask ----------------------------------------------------------
// (api-contracts.md §1 Copilot Q&A, PRD FR-9..FR-13)

export const ANSWER_STATUSES = ["draft", "refused", "approved", "rejected"] as const;
export const ANSWER_SOURCES = ["llm", "extractive", "none"] as const;
export const REFUSAL_REASONS = ["below_grounding_threshold", "no_valid_citations"] as const;

export const answerStatusSchema = z.enum(ANSWER_STATUSES);
export type AnswerStatus = z.infer<typeof answerStatusSchema>;

export const answerSourceSchema = z.enum(ANSWER_SOURCES);
export type AnswerSource = z.infer<typeof answerSourceSchema>;

export const refusalReasonSchema = z.enum(REFUSAL_REASONS);
export type RefusalReason = z.infer<typeof refusalReasonSchema>;

export const askRequestSchema = z.object({
  question: z.string().trim().min(5).max(2_000),
});
export type AskRequest = z.infer<typeof askRequestSchema>;

export const citationSchema = z.object({
  chunkId: z.string().uuid(),
  manualId: z.string().uuid(),
  docType: docTypeSchema,
  ataChapter: z.string(),
  taskNo: z.string(),
  sectionPath: z.string(),
  page: z.number().int().positive(),
  revision: z.string(),
  snippet: z.string(),
});
export type Citation = z.infer<typeof citationSchema>;

export const askResponseSchema = z.object({
  answerId: z.string().uuid(),
  status: z.enum(["draft", "refused"]),
  answer: z.string().optional(),
  citations: z.array(citationSchema).optional(),
  refusalReason: refusalReasonSchema.optional(),
  source: answerSourceSchema,
  provider: z.string(),
  groundingScore: z.number().min(0).max(1),
  retrieval: z.object({
    mode: z.enum(["hybrid", "lexical"]),
    latencyMs: z.number().int().nonnegative(),
  }),
});
export type AskResponse = z.infer<typeof askResponseSchema>;

// --- GET /api/v1/answers (verified library + own drafts) ------------------------

export const reviewBlockSchema = z.object({
  reviewerId: z.string().uuid(),
  reviewerName: z.string(),
  note: z.string().nullable(),
  at: z.string(),
});
export type ReviewBlock = z.infer<typeof reviewBlockSchema>;

export const answerSummarySchema = z.object({
  id: z.string().uuid(),
  question: z.string(),
  status: answerStatusSchema,
  source: answerSourceSchema,
  provider: z.string(),
  refusalReason: refusalReasonSchema.nullable(),
  groundingScore: z.number(),
  citationCount: z.number().int().nonnegative(),
  createdBy: z.string().uuid(),
  createdByName: z.string(),
  createdAt: z.string(),
  review: reviewBlockSchema.nullable(),
});
export type AnswerSummary = z.infer<typeof answerSummarySchema>;

export const answersResponseSchema = z.object({
  answers: z.array(answerSummarySchema),
  nextCursor: z.string().nullable(),
});
export type AnswersResponse = z.infer<typeof answersResponseSchema>;

export const answerDetailSchema = answerSummarySchema.extend({
  answerText: z.string().nullable(),
  citations: z.array(citationSchema),
  retrievalMeta: z.object({
    mode: z.enum(["hybrid", "lexical"]),
    topK: z.number().int().positive(),
    latencyMs: z.number().int().nonnegative(),
  }),
});
export type AnswerDetail = z.infer<typeof answerDetailSchema>;

export const auditEventSchema = z.object({
  id: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  eventType: z.string(),
  actorName: z.string().nullable(),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

// --- GET /api/v1/reviews/queue ---------------------------------------------------

export const reviewQueueResponseSchema = z.object({
  queue: z.array(answerDetailSchema),
  nextCursor: z.string().nullable(),
});
export type ReviewQueueResponse = z.infer<typeof reviewQueueResponseSchema>;

// --- POST /api/v1/answers/{id}/reject ---------------------------------------------

export const rejectRequestSchema = z.object({
  note: z.string().trim().min(3).max(2_000),
});

// --- Evaluation runs (api-contracts.md §1 Evaluation, PRD FR-21) -------------------

export const evalGatesSchema = z.object({
  recallAt5: z.number().nullable(),
  refusalAccuracy: z.number().nullable(),
  citationValidity: z.number().nullable(),
  groundedRate: z.number().nullable(),
});
export type EvalGates = z.infer<typeof evalGatesSchema>;

export const evalRunSummarySchema = z.object({
  runId: z.string().uuid(),
  mode: z.string(),
  fixtureVersion: z.number().int(),
  startedAt: z.string(),
  gates: evalGatesSchema,
  passed: z.boolean(),
});
export type EvalRunSummary = z.infer<typeof evalRunSummarySchema>;

export const evalRunsResponseSchema = z.object({
  runs: z.array(evalRunSummarySchema),
});
export type EvalRunsResponse = z.infer<typeof evalRunsResponseSchema>;

export const evalRunDetailSchema = evalRunSummarySchema.extend({
  metrics: z.record(z.unknown()),
  caseSummaries: z.record(z.unknown()),
  reportPath: z.string().nullable(),
});
export type EvalRunDetail = z.infer<typeof evalRunDetailSchema>;

export const createEvalRunRequestSchema = z.object({
  mode: z.enum(["retrieval", "full"]),
  fixtureVersion: z.number().int().positive(),
  startedAt: z.string().datetime(),
  metrics: z.record(z.unknown()),
  gates: evalGatesSchema,
  passed: z.boolean(),
  caseSummaries: z.record(z.unknown()),
  reportPath: z.string().max(500).optional(),
});
export type ChunkDetailResponse = z.infer<typeof chunkDetailResponseSchema>;
