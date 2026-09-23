import { sql } from "drizzle-orm";

import { createDb } from "@aviation/db/client";
import { createHealthServer, listenHealthServer } from "@aviation/db/health";
import { createRedis } from "@aviation/db/redis";
import { CHAN_REPLAN_CONTROL, replanControlCommandSchema } from "@aviation/tiq-domain";

/**
 * Service entrypoint (architecture.md §2): owns risk rules (F-3) + constraint
 * scheduler (F-4). Tails the PostgreSQL event log, raises alert events, answers
 * replan proposals from REST via a Redis control channel + result keys, and
 * applies approved plans as task.rescheduled events. /healthz + /readyz per §7.
 */
import { ReplanEngine } from "./engine";
import { createLogger } from "./logger";

const logger = createLogger("replan-engine");

const ENGINE_PORT = Number(process.env.REPLAN_ENGINE_PORT ?? 4102);
const POLL_INTERVAL_MS = Number(process.env.REPLAN_POLL_MS ?? 300);

async function main(): Promise<void> {
  const { db, close: closeDb } = createDb();
  const redis = await createRedis();
  // Redis connections are role-specialized: a subscribed connection can only
  // (P|S)UBSCRIBE/PING/QUIT — control listens, the command client publishes.
  const control = await createRedis();

  const engine = new ReplanEngine({
    db,
    redis: redis.redis,
    logger,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
  await engine.start();

  await control.redis.subscribe(CHAN_REPLAN_CONTROL, (raw) => {
    try {
      const command = replanControlCommandSchema.parse(JSON.parse(raw));
      if (command.action !== "propose") return;
      void engine.propose(command.requestId, command.flightId).catch((err: unknown) =>
        logger.error({
          msg: "propose failed",
          requestId: command.requestId,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    } catch (err) {
      logger.warn({
        msg: "invalid replan control command",
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const health = createHealthServer({
    port: ENGINE_PORT,
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
  await listenHealthServer(health, ENGINE_PORT);

  logger.info({ msg: "replan engine ready", port: ENGINE_PORT, pollMs: POLL_INTERVAL_MS });

  const shutdown = (signal: string): void => {
    logger.info({ msg: "shutting down", signal });
    engine.stop();
    health.close();
    void (async () => {
      await control.close();
      await redis.close();
      await closeDb();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({
    msg: "replan engine crashed",
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
