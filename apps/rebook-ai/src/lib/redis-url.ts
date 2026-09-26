import { DEFAULT_LOCAL_REDIS_URL } from "@aviation/db/redis";

/**
 * The web app must reach Redis the same way the rest of the rebook stack does
 * (REDIS_URL from compose, loopback default on the host). Kept as a tiny
 * helper so the SSE bridge can open per-stream subscriber connections without
 * importing turnaround-iq defaults by side effect.
 */
export function resolveRedisUrl(url: string | undefined = process.env.REDIS_URL): string {
  return url ?? DEFAULT_LOCAL_REDIS_URL;
}
