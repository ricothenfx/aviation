import { describe, expect, it } from "vitest";

import { LlmGateway, ProviderUnavailableError } from "@aviation/llm-gateway";

import { copilotMessages, explainFromFacts, rulesNarrative, type ReplanFacts } from "./explain";

/**
 * F4 DoD (milestones.md §F4): the copilot explanation's `source` label must be
 * correct WITH a provider (llm) and WITHOUT one (degrade to rules, ADR-0003).
 * Both paths are pinned here against the pure orchestrator.
 */

const FACTS: ReplanFacts = {
  replanId: "9f1c8e64-2b7d-4c3a-8f21-5d4e6a7b8c9d",
  flightNo: "NX208",
  standCode: "A12",
  totalDelayMin: 6,
  baselineDelayMin: 47,
  rationale: "5 tasks rescheduled around open constraints; projected departure slip 6 min",
  movedTasks: [
    {
      taskType: "baggage_load",
      newStart: "2026-09-22T08:20:00.000Z",
      newEnd: "2026-09-22T08:35:00.000Z",
    },
    {
      taskType: "boarding",
      newStart: "2026-09-22T08:40:00.000Z",
      newEnd: "2026-09-22T09:00:00.000Z",
    },
  ],
};

describe("explainFromFacts source labels (F4 DoD)", () => {
  it("labels source=llm when the gateway serves (mock provider default)", async () => {
    const explanation = await explainFromFacts({
      facts: FACTS,
      gateway: LlmGateway.fromEnv({ LLM_PROVIDER: "mock" } as unknown as NodeJS.ProcessEnv),
      now: "2026-09-22T08:00:00.000Z",
    });
    expect(explanation.source).toBe("llm");
    expect(explanation.provider).toBe("mock");
    expect(explanation.replanId).toBe(FACTS.replanId);
    expect(explanation.text).toContain("mock");
    expect(explanation.generatedAt).toBe("2026-09-22T08:00:00.000Z");
  });

  it("degrades to source=rules with provider null when no provider is available", async () => {
    const failingGateway = {
      providerName: "mock" as const,
      complete: () => Promise.reject(new ProviderUnavailableError("provider call failed")),
    };
    const explanation = await explainFromFacts({
      facts: FACTS,
      gateway: failingGateway,
      now: "2026-09-22T08:00:00.000Z",
    });
    expect(explanation.source).toBe("rules");
    expect(explanation.provider).toBeNull();
    expect(explanation.text).toBe(rulesNarrative(FACTS));
    // The rules narrative is honest about the degrade AND keeps the delay math.
    expect(explanation.text).toContain("LLM provider unavailable");
    expect(explanation.text).toContain("6 min");
    expect(explanation.text).toContain("47 min");
  });

  it("degrades to source=rules when no gateway could be constructed (provider off)", async () => {
    const explanation = await explainFromFacts({
      facts: FACTS,
      gateway: null,
      now: "2026-09-22T08:00:00.000Z",
    });
    expect(explanation.source).toBe("rules");
    expect(explanation.provider).toBeNull();
    expect(explanation.text).toBe(rulesNarrative(FACTS));
  });

  it("propagates non-provider errors instead of mislabeling them as rules", async () => {
    const brokenGateway = {
      providerName: "mock" as const,
      complete: () => Promise.reject(new TypeError("programming bug")),
    };
    await expect(explainFromFacts({ facts: FACTS, gateway: brokenGateway })).rejects.toThrow(
      TypeError,
    );
  });
});

describe("rulesNarrative", () => {
  it("handles the unprojectable-baseline sentinel honestly", () => {
    const text = rulesNarrative({ ...FACTS, baselineDelayMin: -1 });
    expect(text).toContain("no do-nothing baseline available");
    expect(text).not.toContain("saves");
  });

  it("covers the zero-move plan", () => {
    const text = rulesNarrative({ ...FACTS, movedTasks: [] });
    expect(text).toContain("no tasks need to move");
  });
});

describe("copilotMessages", () => {
  it("is deterministic and grounds the model in facts only", () => {
    expect(copilotMessages(FACTS)).toEqual(copilotMessages({ ...FACTS }));
    const messages = copilotMessages(FACTS);
    const system = messages[0];
    const user = messages[1];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("never decide schedules");
    expect(user?.content).toContain("NX208");
    expect(user?.content).toContain("baggage_load: 08:20Z–08:35Z");
    expect(user?.content).toContain("boarding: 08:40Z–09:00Z");
    expect(user?.content).toContain("47 min");
  });
});
