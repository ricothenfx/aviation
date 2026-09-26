import { z } from "zod";

/**
 * Standard API error envelope (api-contracts.md §2). Every REST error response uses this shape.
 * rebook-ai joins the codes ADDITIVELY (rebook-ai api-contracts.md §1).
 */
export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "REPLAN_INFEASIBLE",
  "RATE_LIMITED",
  "INTERNAL",
  "OFFER_EXPIRED",
  "SAGA_CONFLICT",
  "PROPOSAL_NOT_PENDING",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status per error code, per api-contracts.md §2. */
export const ERROR_STATUS: { [K in ErrorCode]: number } = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  REPLAN_INFEASIBLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  OFFER_EXPIRED: 409,
  SAGA_CONFLICT: 409,
  PROPOSAL_NOT_PENDING: 409,
};

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string().min(1),
    details: z.record(z.string(), z.array(z.string())).optional(),
    requestId: z.string().min(1),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** Typed API error — thrown by handlers, rendered by the response helper. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, string[]>;

  constructor(code: ErrorCode, message: string, details?: Record<string, string[]>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}
