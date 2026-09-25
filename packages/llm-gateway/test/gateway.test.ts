import { describe, expect, it } from "vitest";

import { LlmGateway } from "../src/gateway";
import { MockProvider } from "../src/mock-provider";
import { ProviderUnavailableError } from "../src/types";

describe("MockProvider (ADR-0003)", () => {
  const provider = new MockProvider();

  it("is deterministic: same prompt, same output", async () => {
    const request = { messages: [{ role: "user" as const, content: "Explain the replan." }] };
    const a = await provider.complete(request);
    const b = await provider.complete(request);
    expect(a.text).toBe(b.text);
    expect(a.provider).toBe("mock");
  });

  it("accounts tokens on both sides", async () => {
    const result = await provider.complete({
      messages: [{ role: "user", content: "Why is baggage load blocked?" }],
    });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it("produces normalized deterministic embeddings", async () => {
    const a = await provider.embed("loader breakdown");
    const b = await provider.embed("loader breakdown");
    expect(a.vector).toEqual(b.vector);
    const norm = Math.hypot(...a.vector);
    expect(norm).toBeCloseTo(1, 2);
  });
});

describe("LlmGateway.fromEnv (ADR-0003)", () => {
  it("defaults to the mock provider", () => {
    expect(LlmGateway.fromEnv({}).providerName).toBe("mock");
  });

  it("throws ProviderUnavailableError for not-yet-implemented providers", () => {
    expect(() => LlmGateway.fromEnv({ LLM_PROVIDER: "bedrock-shape" })).toThrow(
      ProviderUnavailableError,
    );
  });

  it("supports an explicit provider-off switch for degrade-to-rules (ADR-0003)", () => {
    expect(() => LlmGateway.fromEnv({ LLM_PROVIDER: "off" })).toThrow(ProviderUnavailableError);
  });
});

describe("MockProvider grounded synthesis (F3, additive)", () => {
  const provider = new MockProvider();

  const groundedPrompt = [
    "Question: What torque applies to the accumulator attach bolts?",
    "",
    "Context:",
    "[1] (NX320 AMM · ATA 29 · Task 29-11-00-000-401 | p.17 | Rev 37)",
    "Remove the accumulator. Torque the accumulator attach bolts to 34.5 Nm in the crosswise sequence shown.",
    "[2] (NX320 AMM · ATA 29 · Task 29-11-00-000-402 | p.18 | Rev 37)",
    "Charge the accumulator to 210 bar with nitrogen. Never oxygen.",
  ].join("\n");

  it("answers grounded prompts with [n] citations drawn from the context", async () => {
    const result = await provider.complete({
      messages: [{ role: "user", content: groundedPrompt }],
    });
    expect(result.text).toContain("[1]");
    expect(result.text).toContain("34.5 Nm");
    // Cited indices must exist in the provided context.
    for (const marker of result.text.matchAll(/\[(\d+)\]/g)) {
      expect(["1", "2"]).toContain(marker[1]);
    }
  });

  it("is deterministic for grounded prompts", async () => {
    const request = { messages: [{ role: "user" as const, content: groundedPrompt }] };
    const a = await provider.complete(request);
    const b = await provider.complete(request);
    expect(a.text).toBe(b.text);
  });

  it("states NOT COVERED without citation markers when no block overlaps", async () => {
    const unrelated = [
      "Question: What is the winglet retrofit bolt torque?",
      "",
      "Context:",
      "[1] (NX320 AMM · ATA 29 · Task 29-11-00-000-401 | p.17 | Rev 37)",
      "Charge the hydraulic accumulator with nitrogen only.",
    ].join("\n");
    const result = await provider.complete({
      messages: [{ role: "user", content: unrelated }],
    });
    expect(result.text).toContain("NOT COVERED");
    expect(result.text.match(/\[\d+\]/g)).toBeNull();
  });

  it("keeps the legacy echo behaviour for non-grounded prompts", async () => {
    const result = await provider.complete({
      messages: [{ role: "user", content: "Explain the replan for NX101." }],
    });
    expect(result.text).toContain("Deterministic mock response");
    expect(result.text).not.toContain("NOT COVERED");
  });
});
