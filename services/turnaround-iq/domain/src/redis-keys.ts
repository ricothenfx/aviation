/**
 * Redis key + channel design (data-model.md §3). Shared by simulator, gateway
 * and REST so no call site invents keys ad hoc.
 */

// Pub/sub channels -----------------------------------------------------------
/** Raw domain-event feed: simulator publishes, projection worker consumes. */
export const CHAN_EVENTS = "chan:events";
/** Wire channel for board subscribers (api-contracts.md §3). */
export const CHAN_BOARD = "chan:board";
export const chanFlight = (flightId: string): string => `chan:flight:${flightId}`;
/** Simulator control (scenario start/reset/speed/inject) — REST publishes, simulator consumes. */
export const CHAN_SCENARIO_CONTROL = "chan:scenario:control";
/** Replan-engine control (F3): REST proposes, the engine computes and answers. */
export const CHAN_REPLAN_CONTROL = "chan:replan:control";

// Keys -----------------------------------------------------------------------
/** Hash: ScenarioClockState (scenario.ts). */
export const KEY_SCENARIO_STATE = "scenario:state";
/** Hash per flight: serialized FlightProjection (data-model.md §3). */
export const projFlightKey = (flightId: string): string => `proj:flight:${flightId}`;
/** Set of flight ids present in the live projection. */
export const KEY_PROJ_BOARD_INDEX = "proj:board:index";
/** Hash: KPI strip aggregates (PRD F-6). */
export const KEY_PROJ_BOARD_SUMMARY = "proj:board:summary";
/** Replan RPC reply (F3): engine stores the propose result for the REST caller. */
export const replanResultKey = (requestId: string): string => `replan:result:${requestId}`;
/** Pattern covering every projection key (scenario reset truncation). */
export const PROJECTION_KEY_PATTERN = "proj:*";
