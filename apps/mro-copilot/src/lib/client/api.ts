"use client";

import { searchResponseSchema, type SearchResponse } from "@/lib/api/schemas";

/**
 * Small client-side fetch helper: strict zod response parsing and the standard
 * error envelope surfaced as a typed error (api-contracts.md §2) so screens
 * can render honest error states with the requestId (ui-design-system §7).
 */

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;

  constructor(code: string, message: string, status: number, requestId?: string) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; requestId?: string };
}

export async function apiGet<T>(
  path: string,
  parse: (raw: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { signal, cache: "no-store" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiClientError("NETWORK_ERROR", "network request failed", 0);
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (body as ApiErrorBody).error;
    throw new ApiClientError(
      error?.code ?? "INTERNAL",
      error?.message ?? `request failed (${res.status})`,
      res.status,
      error?.requestId,
    );
  }
  return parse(body);
}

/** Convenience: GET /api/v1/search with validated response. */
export function apiSearch(params: URLSearchParams, signal?: AbortSignal): Promise<SearchResponse> {
  return apiGet(`/api/v1/search?${params.toString()}`, searchResponseSchema.parse, signal);
}

/** POST JSON with the same error-envelope handling as apiGet. */
export async function apiPost<T>(
  path: string,
  body: unknown,
  parse: (raw: unknown) => T,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiClientError("NETWORK_ERROR", "network request failed", 0);
  }
  const parsed: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (parsed as ApiErrorBody).error;
    throw new ApiClientError(
      error?.code ?? "INTERNAL",
      error?.message ?? `request failed (${res.status})`,
      res.status,
      error?.requestId,
    );
  }
  return parse(parsed);
}

// --- Engine health (F4) -------------------------------------------------------

import {
  engineAlertSchema,
  engineAlertsResponseSchema,
  engineDetailSchema,
  engineModelSchema,
  enginesResponseSchema,
  scoreFleetResponseSchema,
  type EngineAlert,
  type EngineAlertsResponse,
  type EngineDetail,
  type EngineModel,
  type EnginesResponse,
  type ScoreFleetResponse,
} from "@/lib/api/schemas";

export function apiEngines(signal?: AbortSignal): Promise<EnginesResponse> {
  return apiGet("/api/v1/engines", enginesResponseSchema.parse, signal);
}

export function apiEngineModel(signal?: AbortSignal): Promise<EngineModel> {
  return apiGet("/api/v1/engines/model", engineModelSchema.parse, signal);
}

export function apiEngineDetail(unitId: string, signal?: AbortSignal): Promise<EngineDetail> {
  return apiGet(`/api/v1/engines/${encodeURIComponent(unitId)}`, engineDetailSchema.parse, signal);
}

export function apiEngineAlerts(
  status: string | null,
  signal?: AbortSignal,
): Promise<EngineAlertsResponse> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return apiGet(`/api/v1/engines/alerts${qs}`, engineAlertsResponseSchema.parse, signal);
}

export async function apiScoreFleet(): Promise<ScoreFleetResponse> {
  return apiPost("/api/v1/engines/score-fleet", {}, scoreFleetResponseSchema.parse);
}

export async function apiAcknowledgeAlert(alertId: string): Promise<EngineAlert> {
  return apiPost(
    `/api/v1/engines/alerts/${encodeURIComponent(alertId)}/acknowledge`,
    {},
    engineAlertSchema.parse,
  );
}

export async function apiResolveAlert(alertId: string, note: string): Promise<EngineAlert> {
  return apiPost(
    `/api/v1/engines/alerts/${encodeURIComponent(alertId)}/resolve`,
    { note },
    engineAlertSchema.parse,
  );
}
