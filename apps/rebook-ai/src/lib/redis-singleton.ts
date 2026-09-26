import { createRedis, type RedisClientType } from "@aviation/db/redis";

/**
 * Redis connections for the web app (architecture.md §4): a publisher for
 * control-channel commands and a dedicated subscriber for the SSE live bridge
 * (subscriber connections cannot issue regular commands). Cached on
 * globalThis so Next.js dev-mode reloads reuse them. Channel names come from
 * `@aviation/contracts` (REBOOK_LIVE_CHANNEL / REBOOK_CONTROL_CHANNEL).
 */

interface RedisPair {
  publisher: RedisClientType;
  subscriber: RedisClientType;
  close: () => Promise<void>;
}

const globalStore = globalThis as unknown as { __rebookRedis?: Promise<RedisPair> };

export function getSingletonRedis(): Promise<RedisPair> {
  if (!globalStore.__rebookRedis) {
    globalStore.__rebookRedis = (async () => {
      const pub = await createRedis();
      const sub = await createRedis();
      return {
        publisher: pub.redis,
        subscriber: sub.redis,
        close: async () => {
          await pub.close();
          await sub.close();
        },
      };
    })();
  }
  return globalStore.__rebookRedis;
}
