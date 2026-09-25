import { spawnSync, type SpawnSyncReturns } from "child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Extractive fallback, end-to-end (DoD F3, FR-12, architecture.md §6): with
 * the LLM provider KILLED (LLM_PROVIDER=off), the ask flow must still serve a
 * USEFUL, HONEST answer — the top retrieved chunks VERBATIM, labeled
 * `source: "extractive"` — instead of failing.
 *
 * A one-off degraded web container joins the running compose network (same
 * database + ai-service, no LLM provider), mirroring the F2 degradation-ladder
 * precedent: the fallback is proven against the real stack, not a mock.
 */

const DEGRADED_URL = process.env.MRO_WEB_OFF_URL ?? "http://127.0.0.1:3009";
const QUESTION = "What torque applies to the hydraulic accumulator attach bolts?";

function docker(args: string[]): SpawnSyncReturns<Buffer> {
  return spawnSync("docker", args, { encoding: "buffer", timeout: 300_000 });
}

let degradedUp = false;

beforeAll(async () => {
  const info = docker(["info"]);
  if (info.status !== 0) {
    throw new Error("docker is required for the extractive fallback integration test");
  }
  docker(["rm", "-f", "mro-web-off"]);
  const run = docker([
    "compose",
    "--profile",
    "mro",
    "run",
    "-d",
    "--name",
    "mro-web-off",
    "-p",
    "127.0.0.1:3009:3003",
    "-e",
    "LLM_PROVIDER=off",
    "mro-web",
    "sh",
    "-c",
    "corepack enable && " +
      "NEXT_DIST_DIR=.next-off pnpm --filter mro-copilot build && " +
      "NEXT_DIST_DIR=.next-off pnpm --filter mro-copilot start",
  ]);
  if (run.status !== 0) {
    throw new Error(`failed to start degraded web container: ${run.stderr.toString()}`);
  }
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const res = await fetch(`${DEGRADED_URL}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        degradedUp = true;
        return;
      }
    } catch {
      // not up yet (next build inside the container takes a while)
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("degraded web container never became healthy on 3009");
}, 300_000);

afterAll(() => {
  docker(["rm", "-f", "mro-web-off"]);
});

describe("extractive fallback with the LLM provider killed (FR-12)", () => {
  it("answers verbatim from the top chunks and labels the source honestly", async () => {
    expect(degradedUp).toBe(true);
    const login = await fetch(`${DEGRADED_URL}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "siti.rahayu@mro-sim.example", password: "engineer-nx-01" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const res = await fetch(`${DEGRADED_URL}/api/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ question: QUESTION }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      answer?: string;
      citations?: Array<{ chunkId: string; manualId: string }>;
      source: string;
      provider: string;
      refusalReason?: string;
      retrieval: { mode: string };
    };
    expect(body.status).toBe("draft");
    expect(body.source).toBe("extractive");
    expect(body.provider).toBe("none");
    expect((body.citations ?? []).length).toBeGreaterThanOrEqual(1);
    expect(body.retrieval.mode).toBe("hybrid");

    // api-contracts §4: source "extractive" ⟺ answer text is verbatim chunk
    // content (concatenated). The answer must begin with the first cited
    // chunk's full content.
    const { rows } = await queryChunkContent(body.citations![0]!.chunkId);
    expect(body.answer!.startsWith(rows)).toBe(true);
  });
});

async function queryChunkContent(chunkId: string): Promise<{ rows: string }> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString:
      process.env.MRO_DATABASE_URL ??
      "postgresql://turnaround:turnaround@localhost:5433/mro_copilot",
    max: 1,
  });
  try {
    const result = await pool.query<{ content: string }>(
      "select content from chunks where id = $1",
      [chunkId],
    );
    return { rows: result.rows[0]!.content };
  } finally {
    await pool.end();
  }
}
