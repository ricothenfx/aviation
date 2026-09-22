import { createClient, type RedisClientType } from "redis";

/** Re-exported so services depend on @aviation/db, not the raw driver. */
export type { RedisClientType };

/**
 * Shared Redis client factory (monorepo-architecture.md §1: packages/db owns
 * pg/redis client factories). Redis is the live projection + pub/sub layer only —
 * never the source of truth (architecture.md §4, data-model.md §3).
 */

export const DEFAULT_LOCAL_REDIS_URL = "redis://localhost:6379";

export function resolveRedisUrl(url: string | undefined = process.env.REDIS_URL): string {
  return url ?? DEFAULT_LOCAL_REDIS_URL;
}

export type RedisConnection = {
  redis: RedisClientType;
  close: () => Promise<void>;
};

/**
 * Create (and connect) a Redis client. Redis clients are role-specialized —
 * a subscribing connection cannot issue regular commands — so call sites that
 * both publish and subscribe create two connections (or use duplicate()).
 */
export async function createRedis(url: string = resolveRedisUrl()): Promise<RedisConnection> {
  const redis = createClient({ url }) as RedisClientType;
  redis.on("error", (err: Error) => {
    console.error(
      JSON.stringify({ level: "error", module: "redis", msg: "client error", err: err.message }),
    );
  });
  await redis.connect();
  return {
    redis,
    close: async () => {
      await redis.quit();
    },
  };
}
