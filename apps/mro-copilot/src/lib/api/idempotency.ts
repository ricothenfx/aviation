import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { getSingletonDb } from "@/lib/db-singleton";
import { idempotencyKeys } from "@/db/schema";

import { MroApiError } from "./respond";

/**
 * Idempotency-Key support for mutating endpoints (PRD FR-2,
 * engineering-standards.md §4). mro-copilot has no Redis (architecture.md §1),
 * so the first successful response is stored in PostgreSQL under the client
 * key for replay: a repeat with the same key + method + path replays the
 * stored response (header `Idempotency-Replayed: true`); reuse for a different
 * route is 409 IDEMPOTENCY_CONFLICT. Absent key ⇒ the handler runs once,
 * unchanged.
 */

const MAX_KEY_LENGTH = 200;

export async function withIdempotency(
  request: Request,
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const key = request.headers.get("Idempotency-Key");
  if (!key || key.length > MAX_KEY_LENGTH) return handler();

  const db = getSingletonDb();
  const method = request.method;
  const path = new URL(request.url).pathname;

  const stored = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  const hit = stored[0];
  if (hit) {
    if (hit.method !== method || hit.path !== path) {
      throw new MroApiError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key reused for a different request",
      );
    }
    return new NextResponse(hit.responseBody, {
      status: hit.status,
      headers: { "content-type": "application/json", "Idempotency-Replayed": "true" },
    });
  }

  const response = await handler();
  const body = await response.text();
  // Unique-PK insert; losing a concurrent race is fine — the winner's stored
  // response serves subsequent retries, and this caller still gets its own
  // (equally valid) response.
  await db
    .insert(idempotencyKeys)
    .values({ key, method, path, status: response.status, responseBody: body })
    .onConflictDoNothing();
  return new NextResponse(body, {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}
