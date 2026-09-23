import { describe, expect, it } from "vitest";

import { loadBaselineState } from "../../src/rebuild";

import { openStack, type Stack } from "./helpers";

/**
 * F4 regression (ui-design-system.md §5.1/§8.3): the rebuilt baseline resolves
 * the seeded stand + aircraft-type codes. The F2 build passed empty reference
 * arrays, so every board lane rendered "?" — the Gantt must show real stands.
 */
describe("baseline projections resolve human-readable codes", () => {
  let stack: Stack;

  it("carries real stand and aircraft codes on every flight", async () => {
    stack = await openStack();
    const state = await loadBaselineState(stack.db);
    expect(state.flights.size).toBeGreaterThan(0);
    for (const flight of state.flights.values()) {
      expect(flight.standCode).not.toBe("?");
      expect(flight.standCode).toMatch(/^[AB]\d+$/);
      expect(flight.aircraftTypeCode).not.toBe("?");
      expect(flight.aircraftTypeCode.length).toBeGreaterThanOrEqual(2);
    }
  }, 30000);
});
