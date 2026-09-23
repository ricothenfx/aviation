import { createDb, type Db } from "@aviation/db/client";
import { createRedis, type RedisClientType } from "@aviation/db/redis";
import { emptyLogHash } from "@aviation/tiq-domain";

/**
 * Minimal integration plumbing for the replan-engine suite: talks to the compose
 * stack over its published ports (DATABASE_URL, REDIS_URL, TIQ_BASE_URL) and
 * drives the scenario lifecycle through the production REST path so the running
 * simulator + gateway stay consistent with any direct DB manipulation.
 */

export interface Stack {
  db: Db;
  redis: RedisClientType;
  close: () => Promise<void>;
  resetScenario: () => Promise<void>;
}

export async function openStack(): Promise<Stack> {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    throw new Error("DATABASE_URL and REDIS_URL are required — run against the compose stack");
  }
  const baseUrl = process.env.TIQ_BASE_URL ?? "http://localhost:3001";
  const { db, close: closeDb } = createDb();
  const { redis, close: closeRedis } = await createRedis();

  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "priya.nair@nx-sim.example", password: "supervisor-nx-01" }),
  });
  if (!login.ok) throw new Error(`supervisor login failed: HTTP ${login.status}`);
  const setCookie = login.headers.get("set-cookie");
  if (!setCookie) throw new Error("login response missing set-cookie");
  const cookie = setCookie.split(";")[0] as string;

  return {
    db,
    redis,
    close: async () => {
      await closeRedis();
      await closeDb();
    },
    resetScenario: async () => {
      const res = await fetch(`${baseUrl}/api/v1/scenarios/reference-day/reset`, {
        method: "POST",
        headers: { cookie },
      });
      if (!res.ok) throw new Error(`scenario reset failed: HTTP ${res.status}`);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const state = await redis.hGetAll("scenario:state");
        const settled =
          state.status === "idle" && state.logHash === emptyLogHash() && state.scenarioNow === "";
        if (settled || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}
