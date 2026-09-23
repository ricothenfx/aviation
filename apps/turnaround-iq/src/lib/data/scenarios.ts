import type { ScenarioListResponse, ScenarioState } from "@aviation/contracts";
import {
  DISRUPTION_CATALOG,
  SCENARIO_CATALOG,
  CHAN_SCENARIO_CONTROL,
  scenarioControlCommandSchema,
  type DisruptionId,
  type ScenarioControlCommand,
} from "@aviation/tiq-domain";
import type { RedisClientType } from "@aviation/db/redis";

import { readScenarioState } from "@/lib/data/board";
import { newRequestId } from "@/lib/api/respond";

/**
 * Scenario control path (api-contracts.md §1 Scenarios — supervisor only): REST
 * publishes control commands on Redis; the simulator executes and mirrors the
 * resulting clock into `scenario:state`, which this module polls back so callers
 * get the post-command state.
 */

const COMMAND_SETTLE_TIMEOUT_MS = 4000;
const POLL_STEP_MS = 60;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function publishControl(
  redis: RedisClientType,
  command: ScenarioControlCommand,
): Promise<void> {
  // Validate at the boundary: control frames follow the shared zod schema.
  scenarioControlCommandSchema.parse(command);
  await redis.publish(CHAN_SCENARIO_CONTROL, JSON.stringify(command));
}

export async function listScenarios(redis: RedisClientType): Promise<ScenarioListResponse> {
  const state = await readScenarioState(redis);
  const scenarios = SCENARIO_CATALOG.map((entry) => ({
    ...entry,
    state: {
      scenarioId: entry.id === state.scenarioId ? state.scenarioId : entry.id,
      status: entry.id === state.scenarioId ? state.status : ("idle" as const),
      speed: entry.id === state.scenarioId ? state.speed : 5,
      scenarioNow: entry.id === state.scenarioId ? state.scenarioNow : null,
      logHash: entry.id === state.scenarioId ? state.logHash : null,
    } satisfies ScenarioState,
  }));
  // F4 (additive contract): the injectable script catalog for the scenario console.
  const disruptions = DISRUPTION_CATALOG.map((definition) => ({
    id: definition.id,
    title: definition.title,
    description: definition.description,
    targetTaskType: definition.targetTaskType,
  }));
  return { scenarios, disruptions };
}

/** Start + wait until the clock is observed running. */
export async function startScenario(
  redis: RedisClientType,
  scenarioId: string,
  speed: 1 | 5 | 20,
): Promise<ScenarioState> {
  const requestId = newRequestId();
  await publishControl(redis, { action: "start", scenarioId, speed, requestId });
  const deadline = Date.now() + COMMAND_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readScenarioState(redis);
    if (state.status === "running" || state.status === "completed") return state;
    await sleep(POLL_STEP_MS);
  }
  return readScenarioState(redis);
}

/** Reset + wait for the fresh (empty-log) hash. */
export async function resetScenario(
  redis: RedisClientType,
  scenarioId: string,
): Promise<ScenarioState> {
  const requestId = newRequestId();
  const before = await readScenarioState(redis);
  await publishControl(redis, { action: "reset", scenarioId, requestId });
  const deadline = Date.now() + COMMAND_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readScenarioState(redis);
    const changed = state.status === "idle" && state.scenarioNow === null;
    const hashChanged = state.logHash !== null && state.logHash !== before.logHash;
    if (changed && (hashChanged || before.status === "idle")) return state;
    await sleep(POLL_STEP_MS);
  }
  return readScenarioState(redis);
}

/** Speed change (valid while running). */
export async function changeSpeed(
  redis: RedisClientType,
  scenarioId: string,
  speed: 1 | 5 | 20,
): Promise<ScenarioState> {
  const requestId = newRequestId();
  await publishControl(redis, { action: "speed", scenarioId, speed, requestId });
  const deadline = Date.now() + COMMAND_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readScenarioState(redis);
    if (state.speed === speed) return state;
    await sleep(POLL_STEP_MS);
  }
  return readScenarioState(redis);
}

/** Inject outcome as reported by the simulator's clock mirror (F3). */
export interface InjectOutcomeView {
  disruptionId: string;
  status: "applied" | "no_target";
  flightNo: string | null;
}

/**
 * Disruption injection (api-contracts.md §1 POST /scenarios/{id}/inject —
 * supervisor only): publish the control command, then wait for the simulator to
 * mirror the outcome under the same request id.
 */
export async function injectDisruption(
  redis: RedisClientType,
  scenarioId: string,
  disruptionId: DisruptionId,
): Promise<InjectOutcomeView> {
  const requestId = newRequestId();
  await publishControl(redis, { action: "inject", scenarioId, disruptionId, requestId });
  const deadline = Date.now() + COMMAND_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readScenarioState(redis);
    if (state.lastInject && state.lastInject.requestId === requestId) {
      return {
        disruptionId: state.lastInject.disruptionId,
        status: state.lastInject.status,
        flightNo: state.lastInject.flightNo,
      };
    }
    await sleep(POLL_STEP_MS);
  }
  throw new Error("simulator did not acknowledge the injection in time");
}
