import {
  ApiError,
  ERROR_CODES,
  ERROR_STATUS,
  type ErrorCode as StandardErrorCode,
} from "@aviation/contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { roleAtLeast, type Role } from "@/lib/auth/rbac";
import { logger } from "@/lib/logger";

/**
 * REST response helpers enforcing the standard error envelope (rebook-ai
 * api-contracts.md §1) plus server-side RBAC guards (architecture.md §5:
 * authorization is checked in route handlers; middleware only guards routes).
 *
 * rebook-ai domain codes (OFFER_EXPIRED, SAGA_CONFLICT, PROPOSAL_NOT_PENDING)
 * were registered in `packages/contracts` additively at F1 (rebook-ai
 * api-contracts.md §1), so this module needs no local additions — unlike the
 * mro-copilot precedent, where codes joined locally.
 */

export type ErrorCode = StandardErrorCode;

/** Re-exported so route handlers import the full error surface from one place. */
export { ApiError, ERROR_CODES, ERROR_STATUS };

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
 * violated (PRD F-7: passenger < agent < supervisor). Throws ApiError — render
 * via handleRouteError.
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
