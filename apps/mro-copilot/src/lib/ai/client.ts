import { MroApiError } from "@/lib/api/respond";
import {
  aiServiceReadySchema,
  embedRequestSchema,
  embedResponseSchema,
  type AiServiceReady,
  type EmbedRequest,
  type EmbedResponse,
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

async function postJson(path: string, body: unknown, requestId?: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
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
      throw new MroApiError("AI_SERVICE_UNAVAILABLE", `ai-service ${path} responded ${res.status}`);
    }
    return await res.json();
  } catch (err) {
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

export async function embed(request: EmbedRequest, requestId?: string): Promise<EmbedResponse> {
  const body = embedRequestSchema.parse(request);
  const raw = await postJson("/internal/v1/embed", body, requestId);
  return embedResponseSchema.parse(raw);
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
    if (!res.ok) {
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
