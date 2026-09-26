import { describe, expect, it } from "vitest";

import { loadPolicy, seedDir } from "rebook-ai/seed-fixtures";

import { evaluateVoucher, type EvaluateVoucherInput } from "./vouchers";
import type { DisruptionContext } from "./ranking";

/**
 * Voucher rule engine tests (F2 DoD: explainability with meet/not-meet cases).
 * Every decision carries rule inputs + evaluated values (PRD F-3).
 */

const CANCELLED: DisruptionContext = {
  flightNo: "NX 288",
  origin: "SIN",
  dest: "AMS",
  schedDep: "2026-10-15T09:15:00+08:00",
  schedArr: "2026-10-15T22:15:00+08:00",
  kind: "cancellation",
  delayMinutes: 0,
  reasonCode: "SIM-CANCEL-01",
};

const DELAYED_3H: DisruptionContext = {
  ...CANCELLED,
  kind: "long_delay",
  delayMinutes: 200,
};

function input(overrides: Partial<EvaluateVoucherInput> = {}): EvaluateVoucherInput {
  return { disruption: CANCELLED, tier: "gold", policy: loadPolicy(seedDir()), ...overrides };
}

describe("voucher rule engine (PRD F-3, F2 DoD)", () => {
  it("issues a cancellation voucher with the tier bonus and full criteria", () => {
    const decision = evaluateVoucher(input());
    expect(decision.issued).toBe(true);
    expect(decision.amount).toBe(55); // 40 base + 15 gold
    expect(decision.currency).toBe("SGD");
    const rules = Object.fromEntries(decision.criteria.map((c) => [c.rule, c]));
    expect(rules["cancellation"]?.met).toBe(true);
    expect(rules["cancellation"]?.detail).toContain("kind=cancellation");
    expect(rules["long_delay"]?.met).toBe(false);
    expect(rules["tier_bonus"]?.met).toBe(true);
    expect(rules["tier_bonus"]?.detail).toContain("tier=gold");
  });

  it("issues a long-delay voucher only above the policy threshold", () => {
    const met = evaluateVoucher(input({ disruption: DELAYED_3H, tier: "standard" }));
    expect(met.issued).toBe(true);
    expect(met.amount).toBe(25); // long-delay amount, no standard tier bonus
    const below = evaluateVoucher(input({ disruption: { ...DELAYED_3H, delayMinutes: 120 } }));
    expect(below.issued).toBe(false);
    expect(below.amount).toBe(0);
    const rules = Object.fromEntries(below.criteria.map((c) => [c.rule, c]));
    expect(rules["long_delay"]?.met).toBe(false);
    expect(rules["long_delay"]?.detail).toContain("120 min < 180 min");
  });

  it("caps the amount at the policy maximum — evaluated honestly", () => {
    const policy = {
      ...loadPolicy(seedDir()),
      voucher: { ...loadPolicy(seedDir()).voucher, maxAmount: 45 },
    };
    const decision = evaluateVoucher(input({ policy }));
    expect(decision.amount).toBe(45);
    const rules = Object.fromEntries(decision.criteria.map((c) => [c.rule, c]));
    expect(rules["max_cap"]?.detail).toContain("capped at SGD 45");
  });

  it("does not apply the tier bonus when no base rule is met", () => {
    const decision = evaluateVoucher(input({ disruption: { ...DELAYED_3H, delayMinutes: 10 } }));
    expect(decision.issued).toBe(false);
    const rules = Object.fromEntries(decision.criteria.map((c) => [c.rule, c]));
    expect(rules["tier_bonus"]?.met).toBe(false);
    expect(rules["tier_bonus"]?.detail).toContain("no base voucher issued");
  });

  it("is deterministic for identical inputs", () => {
    expect(evaluateVoucher(input())).toEqual(evaluateVoucher(input()));
  });
});
