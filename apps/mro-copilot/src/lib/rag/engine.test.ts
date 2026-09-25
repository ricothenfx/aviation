import { describe, expect, it } from "vitest";

import type { RetrievalHit } from "@/lib/ai/contract";

import {
  buildRagMessages,
  checkCitations,
  extractiveAnswerText,
  groundingScoreFor,
  isBelowGroundingThreshold,
  parseCitationMarkers,
  stripCitationMarkers,
  type RagBlock,
} from "./engine";

function hit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    chunkId: "018f3c1e-0000-7000-8000-000000000001",
    manualId: "018f3c1e-0000-7000-8000-0000000000aa",
    docType: "AMM",
    taskNo: "29-11-00-000-401",
    ataChapter: "29",
    sectionPath: "NX320 AMM · ATA 29 · Task 29-11-00-000-401",
    page: 17,
    revision: "Rev 37",
    effectiveDate: "2026-03-01",
    snippet: "Torque the [[accumulator]] bolts to 34.5 Nm.",
    score: 0.0263,
    vectorScore: 0.6,
    termCoverage: 0.7,
    ...overrides,
  };
}

function block(index: number, content: string, h = hit()): RagBlock {
  return { index, hit: h, content };
}

describe("grounding score + guardrail pre-check (FR-10)", () => {
  it("blends coverage and cosine in hybrid mode", () => {
    expect(groundingScoreFor("hybrid", [hit()])).toBeCloseTo(0.6 * 0.7 + 0.4 * 0.6, 10);
  });

  it("takes the max over hits", () => {
    const better = hit({ termCoverage: 0.9, vectorScore: 0.8 });
    expect(groundingScoreFor("hybrid", [hit(), better])).toBeCloseTo(0.6 * 0.9 + 0.4 * 0.8, 10);
  });

  it("degrades to coverage-only in lexical mode (vectorScore null)", () => {
    expect(groundingScoreFor("lexical", [hit({ vectorScore: null })])).toBeCloseTo(0.7, 10);
  });

  it("is 0 with no hits and always below the threshold", () => {
    expect(groundingScoreFor("hybrid", [])).toBe(0);
    expect(isBelowGroundingThreshold("hybrid", 0)).toBe(true);
    expect(isBelowGroundingThreshold("lexical", 0)).toBe(true);
  });

  it("respects the calibrated thresholds (0.70 hybrid / 0.70 lexical)", () => {
    expect(isBelowGroundingThreshold("hybrid", 0.69)).toBe(true);
    expect(isBelowGroundingThreshold("hybrid", 0.7)).toBe(false);
    expect(isBelowGroundingThreshold("lexical", 0.69)).toBe(true);
    expect(isBelowGroundingThreshold("lexical", 0.7)).toBe(false);
  });
});

describe("prompt assembly", () => {
  it("builds system guard + numbered context blocks + question", () => {
    const messages = buildRagMessages("What torque applies?", [
      block(1, "Torque the bolts to 34.5 Nm."),
      block(2, "Charge with nitrogen."),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("ONLY the numbered document context");
    const user = messages[1]!.content;
    expect(user).toContain("Question: What torque applies?");
    expect(user).toContain("[1] (");
    expect(user).toContain("Torque the bolts to 34.5 Nm.");
    expect(user).toContain("[2] (");
    expect(user).toContain("MaxBlocks: 3");
  });
});

describe("citation post-check (FR-11)", () => {
  it("parses markers in order", () => {
    expect(parseCitationMarkers("a [1] b [3] c [1]")).toEqual([1, 3, 1]);
  });

  it("separates valid from hallucinated markers", () => {
    const check = checkCitations("Do X [1] then Y [2] or Z [7] [99].", 2);
    expect(check.valid).toEqual([1, 2]);
    expect(check.invalid).toEqual([7, 99]);
  });

  it("strips hallucinated markers and keeps valid ones", () => {
    const stripped = stripCitationMarkers("Do X [1] then Y [7].", [7]);
    expect(stripped).toContain("[1]");
    expect(stripped).not.toContain("[7]");
    expect(stripped).toContain("then Y .");
  });

  it("returns empty valid set when every marker is hallucinated", () => {
    const check = checkCitations("Invented step [42].", 2);
    expect(check.valid).toEqual([]);
    expect(check.invalid).toEqual([42]);
  });
});

describe("extractive fallback (FR-12)", () => {
  it("concatenates chunk content verbatim, capped at the top chunks", () => {
    const text = extractiveAnswerText([
      block(1, "FIRST CONTENT"),
      block(2, "SECOND CONTENT"),
      block(3, "THIRD CONTENT"),
      block(4, "FOURTH — beyond the cap"),
    ]);
    expect(text).toBe("FIRST CONTENT\n\nSECOND CONTENT\n\nTHIRD CONTENT");
  });
});
