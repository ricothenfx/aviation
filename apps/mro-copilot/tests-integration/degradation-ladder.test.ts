import { spawnSync, type SpawnSyncReturns } from "child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Degradation ladder, end-to-end (DoD F2, FR-7, architecture.md §4): with the
 * embedding provider KILLED (LLM_PROVIDER=off → no gateway), search must
 * return `mode: "lexical"` and stay within the wire contract — against the
 * real compose network and the real ingested database, not a mock.
 *
 * A one-off degraded ai-service container joins the running compose network;
 * it shares the database and corpus mounts but serves no embeddings.
 */

const DEGRADED_URL = process.env.MRO_AI_DEGRADED_URL ?? "http://127.0.0.1:4199";
const TOKEN = process.env.AI_SERVICE_TOKEN ?? "dev-only-insecure-ai-token-0123456789abcdef";

function docker(args: string[]): SpawnSyncReturns<Buffer> {
  return spawnSync("docker", args, { encoding: "buffer", timeout: 120_000 });
}

let degradedUp = false;

beforeAll(async () => {
  const info = docker(["info"]);
  if (info.status !== 0) {
    console.warn("docker unavailable — degradation ladder test cannot run honestly; failing");
    throw new Error("docker is required for the degradation ladder integration test");
  }
  docker(["rm", "-f", "mro-ai-degraded"]);
  const run = docker([
    "compose",
    "--profile",
    "mro",
    "run",
    "-d",
    "--name",
    "mro-ai-degraded",
    "-p",
    "127.0.0.1:4199:4103",
    "-e",
    "LLM_PROVIDER=off",
    "mro-ai-service",
    "sh",
    "-c",
    "pip install --no-cache-dir -q -r requirements.txt && uvicorn mro_ai.main:app --host 0.0.0.0 --port 4103",
  ]);
  if (run.status !== 0) {
    throw new Error(`failed to start degraded ai-service: ${run.stderr.toString()}`);
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`${DEGRADED_URL}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        degradedUp = true;
        return;
      }
    } catch {
      // not up yet (pip install + uvicorn boot)
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("degraded ai-service never became healthy on 4199");
});

afterAll(() => {
  docker(["rm", "-f", "mro-ai-degraded"]);
});

describe("degradation ladder with the embedding provider killed (FR-7)", () => {
  it("readiness reports the provider down", async () => {
    expect(degradedUp).toBe(true);
    const res = await fetch(`${DEGRADED_URL}/readyz`);
    const body = (await res.json()) as {
      status: string;
      dependencies: { provider: string; postgres: string; pgvector: string };
    };
    expect(res.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.dependencies.provider).toBe("down");
    expect(body.dependencies.postgres).toBe("up");
  });

  it("embed fails loudly without a provider", async () => {
    const res = await fetch(`${DEGRADED_URL}/internal/v1/embed`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ texts: ["hello"] }),
    });
    expect(res.status).toBe(503);
  });

  it("search returns mode lexical and stays within contract", async () => {
    const res = await fetch(`${DEGRADED_URL}/internal/v1/retrieval/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "torque the accumulator attach bolts", k: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      results: Array<Record<string, unknown>>;
      latencyMs: number;
    };
    expect(body.mode).toBe("lexical");
    expect(body.results.length).toBeGreaterThan(0);
    for (const hit of body.results) {
      // SearchHit contract fields all present, degraded or not
      for (const field of [
        "chunkId",
        "manualId",
        "docType",
        "taskNo",
        "ataChapter",
        "sectionPath",
        "page",
        "revision",
        "snippet",
        "score",
      ]) {
        expect(hit).toHaveProperty(field);
      }
    }
  });
});
