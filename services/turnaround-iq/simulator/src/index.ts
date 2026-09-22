import { sql } from "drizzle-orm";

import { createDb } from "@aviation/db/client";
import { createHealthServer, listenHealthServer } from "@aviation/db/health";
import { createRedis, resolveRedisUrl } from "@aviation/db/redis";

/**
 * Service entrypoint (architecture.md §2): owns the scenario clock, consumes
 * control commands from REST, appends deterministic events to PostgreSQL and
 * publishes them for the projection worker. /healthz + /readyz per §7.
 */
import { buildReferenceDay, CHAN_EVENTS } from "@aviation/tiq-domain";

import { ScenarioEngine } from "./engine";
import { createLogger } from "./logger";
import { connectControlChannel, loadScenarioState, saveScenarioState } from "./scenario-store";

const logger = createLogger("simulator");

const SIMULATOR_PORT = Number(process.env.SIMULATOR_PORT ?? 4101);
const TICK_INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS ?? 250);

async function main(): Promise<void> {
  const { db, close: closeDb } = createDb();
  const eventsRedis = await createRedis();
  const controlRedisUrl = resolveRedisUrl();

  const day = buildReferenceDay();

  const engine = new ScenarioEngine(day, {
    db,
    tickIntervalMs: TICK_INTERVAL_MS,
    logger,
    publish: async (event) => {
      await eventsRedis.redis.publish(CHAN_EVENTS, JSON.stringify(event));
    },
    onStateChange: (state) => saveScenarioState(eventsRedis.redis, state),
  });

  engine.setState(await loadScenarioState(eventsRedis.redis));
  await engine.resync();

  // Control commands are serialized: reset/start arriving back-to-back must
  // execute in publish order (a concurrent start inside a running reset would
  // be clobbered by the reset's final commit).
  let controlChain: Promise<void> = Promise.resolve();
  const control = await connectControlChannel(controlRedisUrl, (command) => {
    controlChain = controlChain
      .then(async () => {
        if (command.scenarioId !== "reference-day") {
          logger.warn({
            msg: "unknown scenario id",
            scenarioId: command.scenarioId,
            requestId: command.requestId,
          });
          return;
        }
        switch (command.action) {
          case "start":
            await engine.start(command.speed);
            break;
          case "speed":
            await engine.setSpeed(command.speed);
            break;
          case "reset":
            await engine.reset();
            break;
        }
      })
      .catch((err: unknown) => {
        logger.error({
          msg: "control command failed",
          action: command.action,
          err: err instanceof Error ? err.message : String(err),
        });
      });
  });

  const health = createHealthServer({
    port: SIMULATOR_PORT,
    onLog: (msg, fields) => logger.warn({ msg, ...fields }),
    checks: {
      postgres: async () => {
        await db.execute(sql`select 1`);
      },
      redis: async () => {
        await eventsRedis.redis.ping();
      },
    },
  });
  await listenHealthServer(health, SIMULATOR_PORT);

  logger.info({ msg: "simulator ready", port: SIMULATOR_PORT, tickMs: TICK_INTERVAL_MS });

  const shutdown = (signal: string): void => {
    logger.info({ msg: "shutting down", signal });
    engine.stop();
    health.close();
    void (async () => {
      await control.close();
      await eventsRedis.close();
      await closeDb();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({ msg: "simulator crashed", err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
