import { createRedis, type RedisClientType, type RedisConnection } from "@aviation/db/redis";
import {
  KEY_SCENARIO_STATE,
  CHAN_SCENARIO_CONTROL,
  scenarioControlCommandSchema,
  initialScenarioState,
  type ScenarioClockState,
  type ScenarioControlCommand,
} from "@aviation/tiq-domain";

/**
 * Redis-backed scenario state (data-model.md §3 spirit): the current clock lives
 * in `scenario:state` so the REST layer reports scenario status without a direct
 * dependency on the simulator process.
 */

export async function loadScenarioState(redis: RedisClientType): Promise<ScenarioClockState> {
  const raw = await redis.hGetAll(KEY_SCENARIO_STATE);
  if (!raw.scenarioId) return initialScenarioState("reference-day");
  return {
    scenarioId: raw.scenarioId,
    status: (raw.status as ScenarioClockState["status"]) ?? "idle",
    speed: (Number(raw.speed) || 5) as ScenarioClockState["speed"],
    scenarioNow: raw.scenarioNow || null,
    lastWallMs: raw.lastWallMs ? Number(raw.lastWallMs) : null,
    logHash: raw.logHash || null,
  };
}

export async function saveScenarioState(
  redis: RedisClientType,
  state: ScenarioClockState,
): Promise<void> {
  await redis.hSet(KEY_SCENARIO_STATE, {
    scenarioId: state.scenarioId,
    status: state.status,
    speed: String(state.speed),
    scenarioNow: state.scenarioNow ?? "",
    lastWallMs: state.lastWallMs === null ? "" : String(state.lastWallMs),
    logHash: state.logHash ?? "",
  });
}

export async function connectControlChannel(
  controlUrl: string,
  onCommand: (command: ScenarioControlCommand) => void | Promise<void>,
): Promise<RedisConnection> {
  const connection = await createRedis(controlUrl);
  await connection.redis.subscribe(CHAN_SCENARIO_CONTROL, (raw) => {
    try {
      const parsed = scenarioControlCommandSchema.parse(JSON.parse(raw));
      void onCommand(parsed);
    } catch (err) {
      // Malformed control messages are logged and dropped — never crash the clock.
      console.warn(
        JSON.stringify({
          level: "warn",
          module: "simulator",
          msg: "invalid scenario control command",
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });
  return connection;
}
