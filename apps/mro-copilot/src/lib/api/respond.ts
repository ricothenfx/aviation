import {
  ApiError,
  ERROR_CODES as STANDARD_ERROR_CODES,
  ERROR_STATUS as STANDARD_ERROR_STATUS,
  type ErrorCode as StandardErrorCode,
} from "@aviation/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { roleAtLeast, type Role } from "@/lib/auth/rbac";
import { logger } from "@/lib/logger";

/**
 * REST response helpers enforcing the standard error envelope (api-contracts.md
 * §2) plus server-side RBAC guards (architecture.md §5: authorization is checked
 * in route handlers, middleware only guards routes).
 *
 * mro-copilot error-code additions live HERE, not in packages/contracts —
 * architecture.md §2: the shared contracts package must not know mro domain
 * semantics beyond the shared envelope. Additions are appended additively so
 * the standard codes keep their contract status mapping.
 */

export const MRO_ERROR_CODES = [
  "INGEST_IN_PROGRESS",
  "MODEL_NOT_LOADED",
  "AI_SERVICE_UNAVAILABLE",
  "SELF_APPROVAL_FORBIDDEN",
] as const;

export type MroErrorCode = (typeof MRO_ERROR_CODES)[number];

const MRO_ERROR_STATUS: { [K in MroErrorCode]: number } = {
  INGEST_IN_PROGRESS: 409,
  MODEL_NOT_LOADED: 503,
  AI_SERVICE_UNAVAILABLE: 503,
  SELF_APPROVAL_FORBIDDEN: 403,
};

export type ErrorCode = StandardErrorCode | MroErrorCode;

/** Re-exported so route handlers import the full error surface from one place. */
export { ApiError };

export const ERROR_STATUS: { [K in ErrorCode]: number } = {
  ...STANDARD_ERROR_STATUS,
  ...MRO_ERROR_STATUS,
};

/**
 * mro-copilot's typed API error. Carries the merged code union (standard +
 * mro additions); contracts.ApiError stays standard-union-typed and is still
 * handled by handleRouteError (e.g. UNAUTHENTICATED from the auth module).
 */
export class MroApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, string[]>;

  constructor(code: ErrorCode, message: string, details?: Record<string, string[]>) {
    super(message);
    this.name = "MroApiError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export function isErrorCode(code: string): code is ErrorCode {
  return (
    (STANDARD_ERROR_CODES as readonly string[]).includes(code) ||
    (MRO_ERROR_CODES as readonly string[]).includes(code)
  );
}

export function newRequestId(): string {
  return `req_${crypto.randomUUID()}`;
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
  logger.info({ msg: "error_response", requestId, code, status });
  return NextResponse.json(
    {
      error: { code, message, ...(options.details ? { details: options.details } : {}), requestId },
    },
    { status },
  );
}

/** Map any thrown error to the standard envelope; unknown errors become INTERNAL. */
export function handleRouteError(err: unknown, requestId?: string): NextResponse {
  if (err instanceof MroApiError) {
    return errorResponse(err.code, err.message, { details: err.details, requestId });
  }
  if (err instanceof ApiError) {
    const code: ErrorCode = isErrorCode(err.code) ? err.code : "INTERNAL";
    return errorResponse(code, err.message, { details: err.details, requestId });
  }
  if (err instanceof z.ZodError) {
    const details: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.join(".") || "_";
      (details[key] ??= []).push(issue.message);
    }
    return errorResponse("VALIDATION_ERROR", "request validation failed", { details, requestId });
  }
  logger.error({
    msg: "unhandled_error",
    requestId,
    err: err instanceof Error ? err.message : String(err),
  });
  return errorResponse("INTERNAL", "unexpected server error", { requestId });
}

export type Session = { sub: string; email: string; name: string; role: Role };

/**
 * Server-side RBAC guard: 401 when unauthenticated, 403 when the role ladder is
 * violated (PRD F-7: viewer < engineer < reviewer). Throws ApiError — render via
 * handleRouteError.
 */
export async function requireSession(minimumRole: Role): Promise<Session> {
  const session = await getSession();
  if (!session) {
    throw new ApiError("UNAUTHENTICATED", "sign in required");
  }
  if (!roleAtLeast(session.role, minimumRole)) {
    throw new ApiError("FORBIDDEN", `requires ${minimumRole} role`, {
      requiredRole: [minimumRole],
    });
  }
  return session;
}
