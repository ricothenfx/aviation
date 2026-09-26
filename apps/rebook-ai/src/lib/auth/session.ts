import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS, verifySessionToken } from "./jwt";
import type { SessionClaims } from "./jwt";

/** Session cookie helpers for server components and route handlers (Next 15 async cookies). */

export async function getSession(): Promise<SessionClaims | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token).catch(() => null);
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
