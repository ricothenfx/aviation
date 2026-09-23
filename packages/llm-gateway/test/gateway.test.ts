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
