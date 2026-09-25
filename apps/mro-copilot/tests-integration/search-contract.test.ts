import { afterAll, describe, expect, it } from "vitest";

import {
  chunkDetailResponseSchema,
  manualsResponseSchema,
  searchResponseSchema,
} from "../src/lib/api/schemas";

/**
 * Wire-level contract + RBAC tests for /api/v1/manuals/* and /api/v1/search
 * (DoD F2). The 3x3 role ladder itself is enforced by the shared
 * requireSession primitive covered by the F1 suite; here we assert the
 * endpoints respect it (401 unauthenticated / 403 below viewer is impossible
 * — viewer is the floor — so any authenticated seeded role passes) and that
 * responses validate against the committed zod contracts.
 */

const BASE_URL = process.env.MRO_BASE_URL ?? "http://localhost:3003";

const SEEDED = [
  { email: "wei.lim@mro-sim.example", password: "reviewer-nx-01", role: "reviewer" },
  { email: "siti.rahayu@mro-sim.example", password: "engineer-nx-01", role: "engineer" },
  { email: "tom.ng@mro-sim.example", password: "viewer-nx-01", role: "viewer" },
];

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

afterAll(async () => {
  // no shared state
});

describe("GET /api/v1/search — contract + RBAC", () => {
  it("rejects unauthenticated requests with the standard envelope", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/search?q=torque`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  for (const account of SEEDED) {
    it(`serves valid hybrid results to a ${account.role}`, async () => {
      const cookie = await login(account.email, account.password);
      const res = await fetch(
        `${BASE_URL}/api/v1/search?q=${encodeURIComponent("torque the accumulator attach bolts")}&limit=5`,
        { headers: { Cookie: cookie } },
      );
      expect(res.status).toBe(200);
      const body = searchResponseSchema.parse(await res.json());
      expect(["hybrid", "lexical"]).toContain(body.mode);
      expect(body.results.length).toBeGreaterThan(0);
      for (const hit of body.results) {
        expect(hit.page).toBeGreaterThan(0);
        expect(hit.snippet.length).toBeGreaterThan(0);
      }
    });
  }

  it("validates the query: missing q is a 400 VALIDATION_ERROR", async () => {
    const cookie = await login(SEEDED[2]!.email, SEEDED[2]!.password);
    const res = await fetch(`${BASE_URL}/api/v1/search`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("clamps limit to the contract maximum of 20", async () => {
    const cookie = await login(SEEDED[2]!.email, SEEDED[2]!.password);
    const res = await fetch(`${BASE_URL}/api/v1/search?q=torque&limit=500`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
  });

  it("applies the docType filter on the wire", async () => {
    const cookie = await login(SEEDED[2]!.email, SEEDED[2]!.password);
    const res = await fetch(
      `${BASE_URL}/api/v1/search?q=${encodeURIComponent("fault code isolation tolerance table")}&docType=TSM&limit=10`,
      { headers: { Cookie: cookie } },
    );
    const body = searchResponseSchema.parse(await res.json());
    expect(body.results.length).toBeGreaterThan(0);
    for (const hit of body.results) {
      expect(hit.docType).toBe("TSM");
    }
  });

  it("excludes superseded revisions from default search (FR-6)", async () => {
    const cookie = await login(SEEDED[2]!.email, SEEDED[2]!.password);
    const res = await fetch(
      `${BASE_URL}/api/v1/search?q=${encodeURIComponent("SB-29-002 reservoir pressurization module fleet improvement")}&limit=20`,
      { headers: { Cookie: cookie } },
    );
    const body = searchResponseSchema.parse(await res.json());
    const revisionOneOnly = body.results.filter(
      (hit) => hit.docType === "SB" && hit.taskNo === "SB-29-002" && hit.revision === "Rev 01",
    );
    expect(revisionOneOnly).toHaveLength(0);
  });
});

describe("GET /api/v1/manuals — contract + RBAC", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/manuals`);
    expect(res.status).toBe(401);
  });

  it("serves a valid list + TOC to a viewer", async () => {
    const cookie = await login(SEEDED[2]!.email, SEEDED[2]!.password);
    const res = await fetch(`${BASE_URL}/api/v1/manuals`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = manualsResponseSchema.parse(await res.json());
    expect(body.manuals.length).toBeGreaterThanOrEqual(40);
    expect(body.toc.length).toBe(4);
    for (const entry of body.toc) {
      expect(entry.chapters.length).toBeGreaterThan(0);
    }
  });

  it("filters by docType and status", async () => {
    const cookie = await login(SEEDED[2]!.email, SEEDED[2]!.password);
    const res = await fetch(`${BASE_URL}/api/v1/manuals?docType=SB&status=superseded`, {
      headers: { Cookie: cookie },
    });
    const body = manualsResponseSchema.parse(await res.json());
    expect(body.manuals.length).toBe(1);
    expect(body.manuals[0]).toMatchObject({ taskNo: "SB-29-002", revision: "Rev 01" });
  });
});

describe("GET /api/v1/manuals/{id} and chunks — contract", () => {
  it("returns metadata + section tree, then resolves a chunk with provenance", async () => {
    const cookie = await login(SEEDED[0]!.email, SEEDED[0]!.password);
    const list = manualsResponseSchema.parse(
      await (
        await fetch(`${BASE_URL}/api/v1/manuals?docType=AMM`, { headers: { Cookie: cookie } })
      ).json(),
    );
    const manual = list.manuals[0]!;

    const detailRes = await fetch(`${BASE_URL}/api/v1/manuals/${manual.id}`, {
      headers: { Cookie: cookie },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      breadcrumb: string;
      sections: { firstChunkId: string; path: string }[];
      chunkCount: number;
    };
    expect(detail.sections.length).toBeGreaterThan(0);
    expect(detail.chunkCount).toBeGreaterThan(0);

    const chunkId = detail.sections[0]!.firstChunkId;
    const chunkRes = await fetch(`${BASE_URL}/api/v1/manuals/${manual.id}/chunks/${chunkId}`, {
      headers: { Cookie: cookie },
    });
    expect(chunkRes.status).toBe(200);
    const chunkBody = chunkDetailResponseSchema.parse(await chunkRes.json());
    expect(chunkBody.chunk.manualId).toBe(manual.id);
    expect(chunkBody.chunk.revision).toBe(manual.revision);
    expect(chunkBody.chunk.content.startsWith(chunkBody.chunk.sectionPath)).toBe(true);
  });

  it("404s unknown manual ids with the standard envelope", async () => {
    const cookie = await login(SEEDED[2]!.email, SEEDED[2]!.password);
    const res = await fetch(`${BASE_URL}/api/v1/manuals/018f3c1e-0000-7000-8000-000000000001`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
