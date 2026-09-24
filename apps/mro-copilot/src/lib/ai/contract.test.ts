import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  EMBED_DIMENSIONS,
  EMBED_MODEL_ID,
  aiServiceReadySchema,
  embedRequestSchema,
  embedResponseSchema,
  tokenUsageSchema,
} from "./contract";

/**
 * TS half of the cross-language contract check (DoD F1: pydantic ↔ zod field
 * parity). Both runtimes parse the SAME committed fixture; each asserts its
 * schema's field names match the fixture's declared field lists, so a field
 * renamed on one side only turns CI red.
 */

const FIXTURE_URL = new URL(
  "../../../../../services/mro-copilot/ai-service/tests/fixtures/embed_contract.json",
  import.meta.url,
);

interface EmbedFixture {
  request: unknown;
  requestFields: string[];
  response: unknown;
  responseFields: string[];
  usageFields: string[];
  vectorDimensions: number;
}

function loadFixture(): EmbedFixture {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as EmbedFixture;
}

describe("embed contract (zod side)", () => {
  const fixture = loadFixture();

  it("parses the shared request fixture and matches declared fields", () => {
    expect(Object.keys(embedRequestSchema.shape)).toEqual(fixture.requestFields);
    expect(() => embedRequestSchema.parse(fixture.request)).not.toThrow();
  });

  it("parses the shared response fixture and matches declared fields", () => {
    expect(Object.keys(embedResponseSchema.shape)).toEqual(fixture.responseFields);
    expect(Object.keys(tokenUsageSchema.shape)).toEqual(fixture.usageFields);
    const parsed = embedResponseSchema.parse(fixture.response);
    expect(parsed.model).toBe(EMBED_MODEL_ID);
    expect(parsed.vectors).toHaveLength(1);
    expect(parsed.vectors[0]).toHaveLength(EMBED_DIMENSIONS);
    expect(parsed.vectors.every((v) => v.every((x) => Number.isFinite(x)))).toBe(true);
  });

  it("rejects malformed payloads", () => {
    expect(embedRequestSchema.safeParse({ texts: [] }).success).toBe(false);
    expect(embedRequestSchema.safeParse({ texts: [""] }).success).toBe(false);
    expect(embedRequestSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(
      embedResponseSchema.safeParse({
        model: EMBED_MODEL_ID,
        vectors: [[0, 1, 2]],
        usage: { inputTokens: 1 },
      }).success,
    ).toBe(false);
    expect(
      embedResponseSchema.safeParse({
        model: EMBED_MODEL_ID,
        vectors: [new Array<number>(EMBED_DIMENSIONS).fill(0)],
      }).success,
    ).toBe(false);
  });

  it("readyz dependency report parses", () => {
    const ready = aiServiceReadySchema.parse({
      status: "ready",
      dependencies: { postgres: "up", pgvector: "up", model: "not_loaded", provider: "up" },
    });
    expect(ready.status).toBe("ready");
    expect(aiServiceReadySchema.safeParse({ status: "nope", dependencies: {} }).success).toBe(
      false,
    );
  });
});
