import { sql } from "drizzle-orm";

import { createDb } from "@aviation/db/client";
import { createHealthServer, listenHealthServer } from "@aviation/db/health";
import { createRedis } from "@aviation/db/redis";

import { createLogger } from "./logger";
import { ProjectionWorker } from "./worker";
import { RealtimeHub } from "./ws-server";

const logger = createLogger("realtime-gateway");

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 4001);
const POLL_INTERVAL_MS = Number(process.env.PROJECTION_POLL_MS ?? 400);
const TICK_INTERVAL_MS = Number(process.env.TICK_BROADCAST_MS ?? 1000);

async function main(): Promise<void> {
  const { db, close: closeDb } = createDb();
  const redis = await createRedis();
  // Redis connections are role-specialized: a subscribed connection can only
  // (P|S)SUBSCRIBE/PING/QUIT. The worker needs one of each.
  const subscriber = await createRedis();

  // Single http server hosts /healthz, /readyz and the /api/ws upgrade.
  const health = createHealthServer({
    port: GATEWAY_PORT,
    onLog: (msg, fields) => logger.warn({ msg, ...fields }),
    checks: {
      postgres: async () => {
        await db.execute(sql`select 1`);
      },
      redis: async () => {
        await redis.redis.ping();
      },
    },
  });

  const hub = new RealtimeHub(logger, health);
  const worker = new ProjectionWorker({
    db,
    redis: redis.redis,
    subscriber: subscriber.redis,
    logger,
    pollIntervalMs: POLL_INTERVAL_MS,
    broadcast: (channels, frame) => hub.broadcast(channels, frame),
  });

  // Serve HTTP before upgrades start flowing.
  await listenHealthServer(health, GATEWAY_PORT);
  await worker.rebuild();
  await worker.start();
  hub.start();
  const tickTimer = setInterval(() => void worker.broadcastTick(), TICK_INTERVAL_MS);

  logger.info({ msg: "realtime gateway ready", port: GATEWAY_PORT, pollMs: POLL_INTERVAL_MS });

  const shutdown = (signal: string): void => {
    logger.info({ msg: "shutting down", signal });
    clearInterval(tickTimer);
    hub.stop();
    worker.stop();
    health.close();
    void (async () => {
      await redis.close();
      await subscriber.close();
      await closeDb();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({
    msg: "realtime gateway crashed",
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
