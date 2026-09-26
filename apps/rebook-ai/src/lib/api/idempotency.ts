import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { ApiError } from "@aviation/contracts";

import { getSingletonDb } from "@/lib/db-singleton";
import { idempotencyKeys } from "@/db/schema";

/**
 * Idempotency-Key replay store for mutating REST (engineering-standards.md §4,
 * data-model.md §2 `idempotency_keys`). Unlike the turnaround-iq F1 Redis
 * store, rebook keeps replays in PostgreSQL — confirmations must survive a
 * Redis flush (crash-safe exactly-one-effect, ADR-0014).
 *
 * - absent key ⇒ handler runs unchanged
 * - same key + method + path ⇒ stored response replayed (`Idempotency-Replayed: true`)
 * - same key, different route ⇒ 409 IDEMPOTENCY_CONFLICT
 * - `requireKey` (confirm endpoint, api-contracts.md §1) rejects missing keys
 */

interface StoredRow {
  method: string;
  path: string;
  status: number;
  responseBody: string;
}

export async function withIdempotency(
  request: Request,
  options: { requireKey?: boolean } = {},
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const key = request.headers.get("Idempotency-Key");
  if (!key) {
    if (options.requireKey) {
      throw new ApiError("VALIDATION_ERROR", "Idempotency-Key header is required");
    }
    return handler();
  }
  const method = request.method;
  const path = new URL(request.url).pathname;

  const db = getSingletonDb();
  const existing = await db
    .select({
      method: idempotencyKeys.method,
      path: idempotencyKeys.path,
      status: idempotencyKeys.status,
      responseBody: idempotencyKeys.responseBody,
    })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  const stored: StoredRow | undefined = existing[0];
  if (stored) {
    if (stored.method !== method || stored.path !== path) {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "Idempotency-Key reused for a different request");
    }
    return new NextResponse(stored.responseBody, {
      status: stored.status,
      headers: { "content-type": "application/json", "Idempotency-Replayed": "true" },
    });
  }

  const response = await handler();
  const body = await response.text();
  await db
    .insert(idempotencyKeys)
    .values({ key, method, path, status: response.status, responseBody: body })
    .onConflictDoNothing();
  return new NextResponse(body, {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}
