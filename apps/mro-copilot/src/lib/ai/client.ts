import { MroApiError } from "@/lib/api/respond";
import {
  aiServiceReadySchema,
  embedRequestSchema,
  embedResponseSchema,
  modelInfoSchema,
  retrievalSearchResponseSchema,
  rulPredictRequestSchema,
  rulPredictionSchema,
  rulScoreFleetRequestSchema,
  rulScoreFleetResponseSchema,
  type AiServiceReady,
  type EmbedRequest,
  type EmbedResponse,
  type ModelInfo,
  type RetrievalSearchResponse,
  type RulPrediction,
  type RulScoreFleetResponse,
} from "@/lib/ai/contract";
import { logger } from "@/lib/logger";

/**
 * HTTP client for the internal ai-service (ADR-0012): bearer-token auth,
 * requestId propagation, strict zod response parsing, and failure mapping to
 * the AI_SERVICE_UNAVAILABLE envelope (architecture.md §6 failure handling).
 * The ai-service is loopback/service-network only — never user-facing.
 */

export const AI_SERVICE_URL = process.env.MRO_AI_SERVICE_URL ?? "http://127.0.0.1:4103";

const DEFAULT_TIMEOUT_MS = 10_000;

function aiServiceToken(): string {
  const token = process.env.AI_SERVICE_TOKEN;
  if (!token) {
    // Loud, explicit misconfiguration — never fall back to tokenless calls
    // (ADR-0012: internal-only, shared-secret bearer).
    throw new MroApiError(
      "AI_SERVICE_UNAVAILABLE",
      "AI_SERVICE_TOKEN is not configured; refusing to call the ai-service",
    );
  }
  return token;
}

async function postJson(
  path: string,
  body: unknown,
  requestId?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${AI_SERVICE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiServiceToken()}`,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      throw await problemToError(path, res);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof AiInsufficientHistoryError) throw err;
    if (err instanceof MroApiError) throw err;
    logger.warn({
      msg: "ai_service_call_failed",
      path,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new MroApiError("AI_SERVICE_UNAVAILABLE", `ai-service ${path} is unreachable`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * F4 typed error: the unit has too little history for an honest prediction.
 * The app composes `latestRul: null` ("—") — never a fabricated number
 * (D-15 honesty precedent, api-contracts.md §3 INSUFFICIENT_HISTORY).
 */
export class AiInsufficientHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiInsufficientHistoryError";
  }
}

interface AiProblemBody {
  code?: string;
  detail?: string;
}

async function problemToError(
  path: string,
  res: Response,
): Promise<MroApiError | AiInsufficientHistoryError> {
  const body = (await res.json().catch(() => ({}))) as AiProblemBody;
  if (body.code === "MODEL_NOT_LOADED") {
    return new MroApiError("MODEL_NOT_LOADED", body.detail ?? "RUL model artifact is not loaded");
  }
  if (body.code === "INSUFFICIENT_HISTORY") {
    return new AiInsufficientHistoryError(body.detail ?? "insufficient history");
  }
  return new MroApiError("AI_SERVICE_UNAVAILABLE", `ai-service ${path} responded ${res.status}`);
}

export async function embed(request: EmbedRequest, requestId?: string): Promise<EmbedResponse> {
  const body = embedRequestSchema.parse(request);
  const raw = await postJson("/internal/v1/embed", body, requestId);
  return embedResponseSchema.parse(raw);
}

export interface RetrievalSearchParams {
  query: string;
  k: number;
  docTypes?: string[];
  ataChapters?: string[];
  revision?: string;
}

/**
 * Hybrid retrieval via the ai-service (ADR-0010). The response names its mode:
 * "lexical" means degraded retrieval (embedding provider unavailable), which
 * callers must surface in the API/UI (FR-7, architecture.md §4).
 */
export async function retrievalSearch(
  params: RetrievalSearchParams,
  requestId?: string,
): Promise<RetrievalSearchResponse> {
  const body: Record<string, unknown> = { query: params.query, k: params.k };
  if (params.docTypes?.length || params.ataChapters?.length || params.revision) {
    body.filters = {
      ...(params.docTypes?.length ? { docTypes: params.docTypes } : {}),
      ...(params.ataChapters?.length ? { ataChapters: params.ataChapters } : {}),
      ...(params.revision ? { revision: params.revision } : {}),
    };
  }
  const raw = await postJson("/internal/v1/retrieval/search", body, requestId);
  return retrievalSearchResponseSchema.parse(raw);
}

export async function aiServiceReady(requestId?: string): Promise<AiServiceReady> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${AI_SERVICE_URL}/readyz`, {
      headers: {
        Authorization: `Bearer ${aiServiceToken()}`,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
    // F4: a 503 (degraded — e.g. model artifact missing) still carries the
    // dependency report; parse it so the app can surface `model: not_loaded`
    // instead of an opaque unreachable (architecture.md §6).
    if (!res.ok && res.status !== 503) {
      throw new MroApiError("AI_SERVICE_UNAVAILABLE", `ai-service readyz responded ${res.status}`);
    }
    return aiServiceReadySchema.parse(await res.json());
  } catch (err) {
    if (err instanceof MroApiError) throw err;
    logger.warn({
      msg: "ai_service_readyz_failed",
      err: err instanceof Error ? err.message : String(err),
    });
    throw new MroApiError("AI_SERVICE_UNAVAILABLE", "ai-service is unreachable");
  } finally {
    clearTimeout(timeout);
  }
}

// --- RUL (F4, api-contracts.md §3, ADR-0011) ----------------------------------

/** Predict RUL for one unit (latest cycle, or `cycle` when given). */
export async function rulPredict(
  params: { unitId: string; cycle?: number },
  requestId?: string,
): Promise<RulPrediction> {
  const body = rulPredictRequestSchema.parse(params);
  const raw = await postJson("/internal/v1/rul/predict", body, requestId);
  return rulPredictionSchema.parse(raw);
}

/** Score a batch of units; short-history units come back in
 * `insufficientHistory` (the app renders latestRul: null for them). */
export async function rulScoreFleet(
  params: { unitIds: string[] },
  requestId?: string,
): Promise<RulScoreFleetResponse> {
  const body = rulScoreFleetRequestSchema.parse(params);
  // Fleet scale: one bulk history round trip + N model inferences; the mock
  // provider path is fast, but real fleets deserve a roomier budget than the
  // default 10 s (PRD §7 has no score-fleet gate; honesty beats a flaky cut).
  const raw = await postJson("/internal/v1/rul/score-fleet", body, requestId, 30_000);
  return rulScoreFleetResponseSchema.parse(raw);
}

/** Current artifact provenance + committed metrics. */
export async function rulModelInfo(requestId?: string): Promise<ModelInfo> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${AI_SERVICE_URL}/internal/v1/model`, {
      headers: {
        Authorization: `Bearer ${aiServiceToken()}`,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      throw await problemToError("/internal/v1/model", res);
    }
    return modelInfoSchema.parse(await res.json());
  } catch (err) {
    if (err instanceof MroApiError || err instanceof AiInsufficientHistoryError) throw err;
    logger.warn({
      msg: "ai_service_model_info_failed",
      err: err instanceof Error ? err.message : String(err),
    });
    throw new MroApiError("AI_SERVICE_UNAVAILABLE", "ai-service is unreachable");
  } finally {
    clearTimeout(timeout);
  }
}
