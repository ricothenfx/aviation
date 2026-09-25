import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  chunkDetailResponseSchema,
  manualsResponseSchema,
  searchResponseSchema,
} from "./schemas";

/**
 * Zod half of the cross-runtime retrieval contract (see the pydantic twin at
 * services/mro-copilot/ai-service/tests/test_search_route.py). Both runtimes
 * parse the SAME committed fixture, so a field renamed on one side only turns
 * CI red.
 */

const FIXTURE_URL = new URL(
  "../../../../../services/mro-copilot/ai-service/tests/fixtures/retrieval_contract.json",
  import.meta.url,
);

interface RetrievalFixture {
  response: unknown;
  responseFields: string[];
  hitFields: string[];
}

function loadFixture(): RetrievalFixture {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as RetrievalFixture;
}

describe("retrieval contract (zod side)", () => {
  const fixture = loadFixture();

  it("parses the committed fixture and keeps wire field names", () => {
    const parsed = searchResponseSchema.parse(fixture.response);
    expect(parsed.mode).toBe("hybrid");
    expect(Object.keys(fixture.response as object)).toEqual(fixture.responseFields);
    expect(Object.keys((fixture.response as { results: object[] }).results[0]!)).toEqual(
      fixture.hitFields,
    );
  });

  it("flags degraded retrieval as a valid mode", () => {
    const degraded = {
      ...(fixture.response as object),
      mode: "lexical",
    };
    const parsed = searchResponseSchema.parse(degraded);
    expect(parsed.mode).toBe("lexical");
  });

  it("rejects an unknown mode (degradation must stay within contract)", () => {
    expect(() =>
      searchResponseSchema.parse({ ...(fixture.response as object), mode: "semantic" }),
    ).toThrow();
  });

  it("manuals responses validate list/TOC/section-tree/chunk shapes", () => {
    expect(() =>
      manualsResponseSchema.parse({
        manuals: [
          {
            id: "018f3c1e-0000-7000-8000-000000000001",
            docType: "AMM",
            title: "hydraulic accumulator — replacement",
            ataChapter: "29",
            taskNo: "29-11-00-000-401",
            revision: "Rev 37",
            effectiveDate: "2026-03-01",
            status: "active",
            chunkCount: 12,
          },
        ],
        toc: [{ docType: "AMM", chapters: [{ chapter: "29", count: 1 }] }],
        nextCursor: null,
      }),
    ).toBeDefined();

    expect(() =>
      chunkDetailResponseSchema.parse({
        chunk: {
          id: "018f3c1e-0000-7000-8000-000000000002",
          manualId: "018f3c1e-0000-7000-8000-000000000001",
          docType: "SB",
          taskNo: "SB-29-002",
          ataChapter: "29",
          title: "reservoir pressurization module fleet improvement",
          revision: "Rev 01",
          effectiveDate: "2025-06-11",
          status: "superseded",
          sectionPath: "NX320 SB · SB-29-002 · Rev 01",
          page: 3,
          chunkIndex: 0,
          content: "…",
          tokenCount: 210,
        },
        navigation: { prevChunkId: null, nextChunkId: null },
      }),
    );
  });
});
