import { describe, expect, it } from "vitest";

import { evaluateAlert } from "@/lib/engines/alerts";

/**
 * F4 alert rules (FR-17/FR-18): raise when predicted RUL crosses the unit's
 * maintenance-window threshold, deduplicated by the open-alert state.
 * leadCycles = predicted remaining cycles at raise (lead time before the
 * projected removal; ≥ 5 in fixtures).
 */
describe("evaluateAlert", () => {
  it("raises when predicted RUL is at or below the threshold and no open alert exists", () => {
    const decision = evaluateAlert({ predictedRul: 20, threshold: 30, openAlertExists: false });
    expect(decision).toEqual({ raise: true, leadCycles: 20, reason: "below_threshold" });
  });

  it("does not raise above the threshold", () => {
    const decision = evaluateAlert({ predictedRul: 84, threshold: 30, openAlertExists: false });
    expect(decision).toEqual({ raise: false, leadCycles: 84, reason: "above_threshold" });
  });

  it("deduplicates while an alert is open (raised or acknowledged)", () => {
    expect(
      evaluateAlert({ predictedRul: 12, threshold: 30, openAlertExists: true }),
    ).toEqual({ raise: false, leadCycles: 12, reason: "already_open" });
  });

  it("treats the threshold boundary as crossing", () => {
    const decision = evaluateAlert({ predictedRul: 30, threshold: 30, openAlertExists: false });
    expect(decision.raise).toBe(true);
  });

  it("never fabricates a lead for deep-window units (honest leadCycles)", () => {
    const decision = evaluateAlert({ predictedRul: 3, threshold: 30, openAlertExists: false });
    expect(decision.raise).toBe(true);
    expect(decision.leadCycles).toBe(3);
  });
});
