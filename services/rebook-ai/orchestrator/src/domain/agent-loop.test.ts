import { describe, expect, it } from "vitest";

import { LlmGateway } from "@aviation/llm-gateway";
import type { SeedInventory, SeedPolicy } from "rebook-ai/seed-fixtures";

import { runProposalLoop, type ProposalLoopInput } from "./agent-loop";

/**
 * F3 DoD (milestones.md): agent-loop determinism with the mock provider —
 * same inputs ⇒ identical proposal hash — inside the < 15 s budget; tool
 * trace completeness; degrade honesty for LLM_PROVIDER=off (D-10).
 * Pure unit test: fixtures + mock gateway, no database (CI unit lane).
 */

const policy: SeedPolicy = {
  currency: "SGD",
  voucher: {
    cancellation: { baseAmount: 40, reason: "Cancellation meal voucher" },
    longDelay: { thresholdMinutes: 180, amount: 25, reason: "Long-delay meal voucher" },
    tierBonus: { gold: 15, silver: 8, standard: 0 },
    maxAmount: 80,
  },
  fareCaps: { standard: 150, silver: 300, gold: 500 },
  offer: { ttlMinutes: 30, maxOptions: 3 },
  disruption: { longDelayMinutes: 240 },
};

const inventory: SeedInventory["candidates"] = [
  {
    airline: "SV",
    flightNo: "SV 1102",
    origin: "SIN",
    dest: "AMS",
    depart: "2026-10-15T11:30:00+08:00",
    arrive: "2026-10-16T01:00:00+08:00",
    cabin: "economy",
    seatsLeft: 9,
    fareDelta: 210,
    refundable: false,
    changeable: false,
    interline: true,
  },
  {
    airline: "NX",
    flightNo: "NX 208",
    origin: "SIN",
    dest: "AMS",
    depart: "2026-10-15T12:40:00+08:00",
    arrive: "2026-10-16T02:10:00+08:00",
    cabin: "economy",
    seatsLeft: 14,
    fareDelta: 260,
    refundable: true,
    changeable: true,
    interline: false,
  },
];

function loopInput(gateway: LlmGateway | null): ProposalLoopInput {
  return {
    pnr: {
      id: "11111111-1111-4111-8111-111111111111",
      locator: "NXQ4ZK",
      tier: "gold",
      fareClass: "Y",
      partySize: 2,
    },
    offer: {
      id: "22222222-2222-4222-8222-222222222222",
      options: [
        {
          id: "33333333-3333-4333-8333-333333333331",
          rank: 1,
          kind: "fast",
          reason: "Earliest arrival 01:00 on SV 1102 (partner SV)",
          segments: [
            {
              airline: "SV",
              flightNo: "SV 1102",
              origin: "SIN",
              dest: "AMS",
              depart: "2026-10-15T11:30:00+08:00",
              arrive: "2026-10-16T01:00:00+08:00",
              cabin: "economy",
            },
          ],
          fareDelta: 210,
          currency: "SGD",
          interline: true,
          refundable: false,
          changeable: false,
          overCap: false,
        },
        {
          id: "33333333-3333-4333-8333-333333333332",
          rank: 2,
          kind: "flexible",
          reason: "NX 208 — refundable and changeable",
          segments: [
            {
              airline: "NX",
              flightNo: "NX 208",
              origin: "SIN",
              dest: "AMS",
              depart: "2026-10-15T12:40:00+08:00",
              arrive: "2026-10-16T02:10:00+08:00",
              cabin: "economy",
            },
          ],
          fareDelta: 260,
          currency: "SGD",
          interline: false,
          refundable: true,
          changeable: true,
          overCap: false,
        },
      ],
    },
    disruption: {
      flightNo: "NX 288",
      origin: "SIN",
      dest: "AMS",
      schedDep: "2026-10-15T08:30:00+08:00",
      schedArr: "2026-10-15T22:10:00+08:00",
      kind: "cancellation",
      delayMinutes: 0,
    },
    inventory,
    policy,
    now: "2026-10-15T09:00:00+08:00",
    gateway,
  };
}

describe("propose-only agent loop (PRD F-5, milestones.md F3 DoD)", () => {
  it("is deterministic under the mock provider: same inputs ⇒ same proposal hash", async () => {
    const gateway = LlmGateway.forProvider({
      name: "mock",
      complete: async (request) => {
        const userTurns = request.messages.filter((m) => m.role === "user");
        const content = userTurns.at(-1)?.content ?? "";
        return {
          text: `mock draft for ${content.length} prompt chars`,
          provider: "mock" as const,
          usage: { inputTokens: content.length, outputTokens: 12 },
        };
      },
      embed: async () => ({ vector: [0, 0, 0, 0, 0, 0, 0, 1], usage: { inputTokens: 1 } }),
    });
    const started = Date.now();
    const first = await runProposalLoop(loopInput(gateway));
    const second = await runProposalLoop(loopInput(gateway));
    const elapsed = Date.now() - started;

    expect(second.proposalHash).toBe(first.proposalHash);
    expect(second.recommendedOptionId).toBe(first.recommendedOptionId);
    expect(second.rationale).toBe(first.rationale);
    expect(elapsed).toBeLessThan(15_000); // DoD budget
  });

  it("labels mock-provider proposals llm/mock and traces every tool call", async () => {
    const gateway = LlmGateway.forProvider({
      name: "mock",
      complete: async () => ({
        text: "Recommended SV 1102 — earliest policy-compliant arrival.",
        provider: "mock" as const,
        usage: { inputTokens: 140, outputTokens: 21 },
      }),
      embed: async () => ({ vector: [0, 0, 0, 0, 0, 0, 0, 1], usage: { inputTokens: 1 } }),
    });
    const out = await runProposalLoop(loopInput(gateway));

    expect(out.source).toBe("llm");
    expect(out.provider).toBe("mock");
    // Trace completeness: search → (price + policy)×options → draft.
    expect(out.toolCalls.map((c) => c.tool)).toEqual([
      "search_routings",
      "price_itinerary",
      "check_policy",
      "price_itinerary",
      "check_policy",
      "draft_proposal",
    ]);
    for (const call of out.toolCalls) {
      expect(Object.keys(call.input).length).toBeGreaterThan(0);
      expect(Object.keys(call.output).length).toBeGreaterThan(0);
      expect(call.durationMs).toBeGreaterThanOrEqual(0);
    }
    // Token usage lands on the draft call and the totals.
    const draft = out.toolCalls.at(-1)!;
    expect(draft.tokens).toEqual({ input: 140, output: 21 });
    expect(out.tokensIn).toBe(140);
    expect(out.tokensOut).toBe(21);
  });

  it("degrades honestly with the provider off: source rules, provider rules-engine (D-10)", async () => {
    const out = await runProposalLoop(loopInput(null));

    expect(out.source).toBe("rules");
    expect(out.provider).toBe("rules-engine");
    expect(out.tokensIn).toBe(0);
    expect(out.tokensOut).toBe(0);
    // Same deterministic pick as the llm mode — only the drafting differs.
    expect(out.recommendedOptionId).toBe("33333333-3333-4333-8333-333333333331");
    expect(out.rationale).toContain("SV 1102");
    expect(out.rationale).toContain("supervisor");
    // Rules mode consumes no tokens anywhere in the trace.
    expect(out.toolCalls.every((c) => c.tokens === undefined)).toBe(true);
  });

  it("surfaces the interline supervisor gate and per-option policy verdicts", async () => {
    const out = await runProposalLoop(loopInput(null));
    const policyCall = out.toolCalls.find(
      (c) =>
        c.tool === "check_policy" && c.input.optionId === "33333333-3333-4333-8333-333333333331",
    );
    expect(policyCall).toBeDefined();
    expect(policyCall!.output).toMatchObject({
      interline: true,
      compliant: false,
    });
  });
});
