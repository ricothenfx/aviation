import type { VoucherCriteriaEntry } from "@aviation/contracts";
import type { PnrTier } from "@aviation/contracts";
import type { SeedPolicy } from "rebook-ai/seed-fixtures";

import type { DisruptionContext } from "./ranking";

/**
 * Voucher rule engine (PRD F-3, data-model.md §2 vouchers). Pure +
 * deterministic. Every rule carries its inputs AND evaluated values in the
 * returned criteria — persisted verbatim so the passenger/agent UI can explain
 * exactly why a voucher was (or was not) issued (F2 DoD: explainability,
 * meet/not-meet cases tested).
 */

export interface VoucherDecision {
  issued: boolean;
  amount: number;
  currency: string;
  reason: string;
  criteria: VoucherCriteriaEntry[];
}

export interface EvaluateVoucherInput {
  disruption: DisruptionContext;
  tier: PnrTier;
  policy: SeedPolicy;
}

export function evaluateVoucher(input: EvaluateVoucherInput): VoucherDecision {
  const { disruption, tier, policy } = input;
  const rules = policy.voucher;

  const cancellationMet = disruption.kind === "cancellation";
  const longDelayMet =
    disruption.kind === "long_delay" && disruption.delayMinutes >= rules.longDelay.thresholdMinutes;

  const criteria: VoucherCriteriaEntry[] = [
    {
      rule: "cancellation",
      description: `Flight cancelled (input: kind=${disruption.kind})`,
      met: cancellationMet,
      detail: cancellationMet
        ? "kind=cancellation → meets the cancellation rule"
        : "flight was not cancelled → rule not met",
    },
    {
      rule: "long_delay",
      description: `Departure delay ≥ ${rules.longDelay.thresholdMinutes} min (input: delayMinutes=${disruption.delayMinutes})`,
      met: longDelayMet,
      detail: longDelayMet
        ? `delay ${disruption.delayMinutes} min ≥ ${rules.longDelay.thresholdMinutes} min → meets the long-delay rule`
        : `delay ${disruption.delayMinutes} min < ${rules.longDelay.thresholdMinutes} min (or not a delay) → rule not met`,
    },
  ];

  const base = cancellationMet
    ? rules.cancellation.baseAmount
    : longDelayMet
      ? rules.longDelay.amount
      : 0;
  const baseRule = cancellationMet ? rules.cancellation : rules.longDelay;
  const tierBonus = rules.tierBonus[tier];
  const issued = base > 0;

  criteria.push({
    rule: "tier_bonus",
    description: `Loyalty tier bonus (input: tier=${tier})`,
    met: issued && tierBonus > 0,
    detail: issued
      ? `tier=${tier} → +SGD ${tierBonus} added to the base voucher`
      : "no base voucher issued → tier bonus not applied",
  });

  // Cap: the amount never exceeds the policy maximum (evaluated honestly).
  const uncapped = issued ? base + tierBonus : 0;
  const amount = Math.min(uncapped, rules.maxAmount);
  if (issued && uncapped > rules.maxAmount) {
    criteria.push({
      rule: "max_cap",
      description: `Policy cap (input: maxAmount=${rules.maxAmount})`,
      met: true,
      detail: `base + tier bonus SGD ${uncapped} capped at SGD ${rules.maxAmount}`,
    });
  }

  return {
    issued,
    amount,
    currency: policy.currency,
    reason: issued ? baseRule.reason : "No voucher criteria met",
    criteria,
  };
}
