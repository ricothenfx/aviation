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
