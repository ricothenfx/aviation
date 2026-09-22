import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, ERROR_STATUS, type ErrorCode } from "@aviation/contracts";

/**
 * REST response helpers enforcing the standard error envelope (api-contracts.md §2).
 * Logs are structured JSON lines (engineering-standards.md §5); pino arrives with the
 * F2 services — the `module`/`requestId` fields are already pino-shaped.
 */

export type Logger = { info: (msg: string, fields?: Record<string, unknown>) => void };

export function newRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

export function logInfo(module: string, msg: string, fields: Record<string, unknown> = {}): void {
  console.info(
    JSON.stringify({ ts: new Date().toISOString(), level: "info", module, msg, ...fields }),
  );
}

export function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  options: { details?: Record<string, string[]>; status?: number; requestId?: string } = {},
): NextResponse {
  const requestId = options.requestId ?? newRequestId();
  const status = options.status ?? ERROR_STATUS[code];
  logInfo("api", "error_response", { requestId, code, status });
  return NextResponse.json(
    {
      error: { code, message, ...(options.details ? { details: options.details } : {}), requestId },
    },
    { status },
  );
}

/** Map any thrown error to the standard envelope; unknown errors become INTERNAL. */
export function handleRouteError(err: unknown, requestId?: string): NextResponse {
  if (err instanceof ApiError) {
    return errorResponse(err.code, err.message, { details: err.details, requestId });
  }
  if (err instanceof z.ZodError) {
    const details: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.join(".") || "_";
      (details[key] ??= []).push(issue.message);
    }
    return errorResponse("VALIDATION_ERROR", "request validation failed", { details, requestId });
  }
  logInfo("api", "unhandled_error", {
    requestId,
    err: err instanceof Error ? err.message : String(err),
  });
  return errorResponse("INTERNAL", "unexpected server error", { requestId });
}
