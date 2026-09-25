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
export type ChunkDetailResponse = z.infer<typeof chunkDetailResponseSchema>;
