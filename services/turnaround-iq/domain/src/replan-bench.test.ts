import { describe, expect, it } from "vitest";

import { runReplanBenchmark } from "./replan-bench";

/**
 * F3 DoD (milestones.md §F3) asserted in CI's unit job: loader-breakdown replan
 * brings total delay 47 → ≤ 9 min, computes in < 2 s, and is deterministic
 * (identical plan hash across runs — same seed ⇒ same day ⇒ same plan).
 */
describe("replan benchmark — loader breakdown (DoD)", () => {
  const result = runReplanBenchmark();

  it("measures the unmanaged cascade at exactly 47 minutes", () => {
    expect(result.baselineDelayMin).toBe(47);
  });

  it("plans the recovery down to ≤ 9 minutes of departure slip", () => {
    expect(result.totalDelayMin).toBeGreaterThanOrEqual(0);
    expect(result.totalDelayMin).toBeLessThanOrEqual(9);
  });

  it("computes well under the 2-second budget for a 12-task turn", () => {
    expect(result.computeMs).toBeLessThan(2000);
    // 12-task turn, 5 tasks already done at the canonical inject instant:
    expect(result.assignments).toBe(7);
  });

  it("is deterministic: identical plan hash across independent runs", () => {
    const again = runReplanBenchmark();
    expect(again.planHash).toBe(result.planHash);
    expect(again.totalDelayMin).toBe(result.totalDelayMin);
  });

  it("projects a departure-risk alert ≥ 10 min ahead of the breach (PRD F-3)", () => {
    expect(result.alertLeadTimeMin).toBeGreaterThanOrEqual(10);
  });
});
