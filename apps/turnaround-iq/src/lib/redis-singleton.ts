import { createRedis, resolveRedisUrl, type RedisClientType } from "@aviation/db/redis";

/**
 * One Redis connection per server process for command use (reads, publishes).
 * Cached on globalThis so Next.js dev-mode reloads reuse it. Subscriber
 * connections are role-specialized and created by their owners only.
 */
const globalStore = globalThis as unknown as { __tiqRedis?: Promise<RedisClientType> };

export function getSingletonRedis(): Promise<RedisClientType> {
  globalStore.__tiqRedis ??= createRedis(resolveRedisUrl()).then((conn) => conn.redis);
  return globalStore.__tiqRedis;
}
