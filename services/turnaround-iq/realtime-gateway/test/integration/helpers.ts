import { createDb, type Db } from "@aviation/db/client";
import { createRedis, type RedisClientType } from "@aviation/db/redis";
import { emptyLogHash } from "@aviation/tiq-domain";

/**
 * Shared integration-test plumbing: talks to the compose stack over its
 * published ports (DATABASE_URL, REDIS_URL, TIQ_BASE_URL). Scenario lifecycle
 * always goes through the production REST control path so the running
 * simulator + gateway containers stay consistent with direct DB manipulation.
 */

export interface Stack {
  db: Db;
  redis: RedisClientType;
  close: () => Promise<void>;
  baseUrl: string;
  resetScenario: () => Promise<void>;
  /** Session cookie for a seeded user (RBAC matrix + flows). */
  cookieFor: (email: string, password: string) => Promise<string>;
}

export const SEED_USERS = {
  supervisor: { email: "priya.nair@nx-sim.example", password: "supervisor-nx-01" },
  coordinator: { email: "maya.tan@nx-sim.example", password: "coordinator-nx-01" },
  viewer: { email: "arif.rahman@nx-sim.example", password: "viewer-nx-01" },
} as const;

export async function loginCookie(
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: HTTP ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("login response missing set-cookie");
  return setCookie.split(";")[0] as string;
}

async function supervisorCookie(baseUrl: string): Promise<string> {
  return loginCookie(baseUrl, SEED_USERS.supervisor.email, SEED_USERS.supervisor.password);
}

async function waitIdle(baseUrl: string, cookie: string): Promise<void> {
  // 30s: back-to-back integration suites (unit lane + e2e + other packages)
  // spike the web/simulator containers; 10s was observed to time out there.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/v1/scenarios`, { headers: { cookie } });
    if (res.ok) {
      const body = (await res.json()) as {
        scenarios: Array<{ state: { status: string; logHash: string | null } }>;
      };
      const state = body.scenarios[0]?.state;
      if (state && state.status === "idle" && state.logHash === emptyLogHash()) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("scenario did not settle to idle with empty log within 10s");
}

export async function openStack(): Promise<Stack> {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    throw new Error("DATABASE_URL and REDIS_URL are required — run against the compose stack");
  }
  const baseUrl = process.env.TIQ_BASE_URL ?? "http://localhost:3001";
  const { db, close: closeDb } = createDb();
  const { redis, close: closeRedis } = await createRedis();
  const cookie = await supervisorCookie(baseUrl);

  return {
    db,
    redis,
    baseUrl,
    close: async () => {
      await closeRedis();
      await closeDb();
    },
    cookieFor: (email: string, password: string) => loginCookie(baseUrl, email, password),
    resetScenario: async () => {
      const res = await fetch(`${baseUrl}/api/v1/scenarios/reference-day/reset`, {
        method: "POST",
        headers: { cookie },
      });
      if (!res.ok) throw new Error(`scenario reset failed: HTTP ${res.status}`);
      await waitIdle(baseUrl, cookie);
    },
  };
}
