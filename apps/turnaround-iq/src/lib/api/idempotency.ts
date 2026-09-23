import { NextResponse } from "next/server";

import { ApiError } from "@aviation/contracts";

import { getSingletonRedis } from "@/lib/redis-singleton";

/**
 * Idempotency-Key support for mutations (api-contracts.md §1 conventions):
 * the first successful response is stored under the key for 24 h; a repeat with
 * the same key + method + path replays it (header `Idempotency-Replayed: true`),
 * a reuse for a different route is a 409 IDEMPOTENCY_CONFLICT. Absent key ⇒ the
 * handler runs once, unchanged.
 */

const TTL_SECONDS = 86_400;

interface StoredResponse {
  method: string;
  path: string;
  status: number;
  body: string;
}

export async function withIdempotency(
  request: Request,
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const key = request.headers.get("Idempotency-Key");
  if (!key) return handler();

  const redis = await getSingletonRedis();
  const redisKey = `idem:${key}`;
  const method = request.method;
  const path = new URL(request.url).pathname;

  const stored = await redis.get(redisKey);
  if (stored) {
    let parsed: StoredResponse;
    try {
      parsed = JSON.parse(stored) as StoredResponse;
    } catch {
      parsed = { method, path, status: 500, body: "{}" };
    }
    if (parsed.method !== method || parsed.path !== path) {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "Idempotency-Key reused for a different request");
    }
    return new NextResponse(parsed.body, {
      status: parsed.status,
      headers: { "content-type": "application/json", "Idempotency-Replayed": "true" },
    });
  }

  const response = await handler();
  const snapshot: StoredResponse = {
    method,
    path,
    status: response.status,
    body: await response.text(),
  };
  await redis.set(redisKey, JSON.stringify(snapshot), { EX: TTL_SECONDS });
  return new NextResponse(snapshot.body, {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}
