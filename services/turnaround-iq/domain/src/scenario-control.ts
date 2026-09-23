import { z } from "zod";

import { scenarioSpeedSchema } from "@aviation/contracts";

import { DISRUPTION_CATALOG, type DisruptionId } from "./disruptions";

/**
 * Scenario control commands (api-contracts.md §1 Scenarios): the REST layer
 * publishes these on chan:scenario:control, the simulator consumes and executes.
 * Control-plane data only — never domain events. F3 adds `inject` (disruption
 * scripts; supervisor-only at the REST boundary).
 */

export const DISRUPTION_IDS: readonly DisruptionId[] = DISRUPTION_CATALOG.map((entry) => entry.id);

export const scenarioControlCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    scenarioId: z.string().min(1),
    speed: scenarioSpeedSchema,
    requestId: z.string().min(1),
  }),
  z.object({
    action: z.literal("reset"),
    scenarioId: z.string().min(1),
    requestId: z.string().min(1),
  }),
  z.object({
    action: z.literal("speed"),
    scenarioId: z.string().min(1),
    speed: scenarioSpeedSchema,
    requestId: z.string().min(1),
  }),
  z.object({
    action: z.literal("inject"),
    scenarioId: z.string().min(1),
    disruptionId: z.enum(DISRUPTION_IDS as [DisruptionId, ...DisruptionId[]]),
    requestId: z.string().min(1),
  }),
]);

export type ScenarioControlCommand = z.infer<typeof scenarioControlCommandSchema>;
