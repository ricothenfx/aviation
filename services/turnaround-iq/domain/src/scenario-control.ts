import { z } from "zod";

import { scenarioSpeedSchema } from "@aviation/contracts";

/**
 * Scenario control commands (api-contracts.md §1 Scenarios): the REST layer
 * publishes these on chan:scenario:control, the simulator consumes and executes.
 * Control-plane data only — never domain events.
 */

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
]);

export type ScenarioControlCommand = z.infer<typeof scenarioControlCommandSchema>;
