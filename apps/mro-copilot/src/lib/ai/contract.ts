import { z } from "zod";

/**
 * TS side of the shared ai-service contract (api-contracts.md §3). The same
 * shapes exist as pydantic models in services/mro-copilot/ai-service — field
 * parity is asserted by contract tests on BOTH runtimes against the committed
 * fixture at services/mro-copilot/ai-service/tests/fixtures/embed_contract.json
 * (DoD: pydantic ↔ zod field parity). Keep the two definitions in lockstep.
 */

export const EMBED_DIMENSIONS = 384;
export const EMBED_MAX_BATCH = 96;
export const EMBED_MODEL_ID = "mock-hashed-ngram-384";

export const embedRequestSchema = z.object({
  texts: z.array(z.string().min(1).max(32_000)).min(1).max(EMBED_MAX_BATCH),
});
export type EmbedRequest = z.infer<typeof embedRequestSchema>;

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const embedResponseSchema = z.object({
  model: z.string().min(1),
  vectors: z.array(z.array(z.number()).length(EMBED_DIMENSIONS)).min(1).max(EMBED_MAX_BATCH),
  usage: tokenUsageSchema,
});
export type EmbedResponse = z.infer<typeof embedResponseSchema>;

/** Dependency report rendered by /readyz on BOTH services (api-contracts.md §1). */
export const dependencyStateSchema = z.enum(["up", "down", "not_loaded", "unconfigured"]);
export type DependencyState = z.infer<typeof dependencyStateSchema>;

export const aiServiceReadySchema = z.object({
  status: z.enum(["ready", "degraded"]),
  dependencies: z.object({
    postgres: dependencyStateSchema,
    pgvector: dependencyStateSchema,
    model: dependencyStateSchema,
    provider: dependencyStateSchema,
  }),
});
export type AiServiceReady = z.infer<typeof aiServiceReadySchema>;

// --- Hybrid retrieval (api-contracts.md §3 /internal/v1/retrieval/search) ----
// The pydantic twin is mro_ai/internal/schemas.py; cross-language parity is
// asserted by both runtimes parsing tests/fixtures/retrieval_contract.json.

export const retrievalHitSchema = z.object({
  chunkId: z.string().uuid(),
  manualId: z.string().uuid(),
  docType: z.enum(["AMM", "IPC", "TSM", "SB"]),
  taskNo: z.string(),
  ataChapter: z.string(),
  sectionPath: z.string(),
  page: z.number().int().positive(),
  revision: z.string(),
  effectiveDate: z.string(),
  snippet: z.string(),
  score: z.number(),
});
export type RetrievalHit = z.infer<typeof retrievalHitSchema>;

/** `mode` flags degraded retrieval (hybrid | lexical) per FR-7. */
export const retrievalSearchResponseSchema = z.object({
  mode: z.enum(["hybrid", "lexical"]),
  results: z.array(retrievalHitSchema),
  latencyMs: z.number().int().nonnegative(),
});
export type RetrievalSearchResponse = z.infer<typeof retrievalSearchResponseSchema>;
