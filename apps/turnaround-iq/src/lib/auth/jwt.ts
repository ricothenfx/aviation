import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";

import { ApiError } from "@aviation/contracts";

/**
 * JWT session tokens for the local auth provider (D-09). Edge-safe (jose + WebCrypto)
 * so middleware can verify sessions without Node APIs.
 */

export const SESSION_ISSUER = "turnaround-iq";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
/** ws upgrade tokens are short-lived (architecture.md §5). */
export const WS_TOKEN_TTL_SECONDS = 60;
export const WS_TOKEN_PURPOSE = "ws";

/** httpOnly session cookie name (architecture.md §5); override via AUTH_COOKIE_NAME. */
export const SESSION_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? "tiq_session";

const claimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["viewer", "coordinator", "supervisor"]),
});

export type SessionClaims = z.infer<typeof claimsSchema>;

/** ENV-provided signing secret; no fallback by design (engineering-standards.md §7). */
export function getSessionSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "AUTH_SECRET is missing or too short (min 16 chars). Copy .env.example to .env and generate one.",
    );
  }
  return secret;
}

export async function signSessionToken(claims: SessionClaims): Promise<string> {
  const key = new TextEncoder().encode(getSessionSecret());
  return new SignJWT({ email: claims.email, name: claims.name, role: claims.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(SESSION_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifySessionToken(token: string): Promise<SessionClaims> {
  const key = new TextEncoder().encode(getSessionSecret());
  try {
    const { payload } = await jwtVerify(token, key, { issuer: SESSION_ISSUER });
    return claimsSchema.parse({
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    });
  } catch (err) {
    throw new ApiError("UNAUTHENTICATED", "invalid or expired session", {
      reason: [err instanceof Error ? err.message : "unknown"],
    });
  }
}

/**
 * Short-lived ws upgrade token (architecture.md §5): same signing key and issuer
 * as the session, but purpose-tagged so it cannot be reused as a session and vice
 * versa. Verified by the realtime gateway (services/turnaround-iq/realtime-gateway).
 */
export async function signWsToken(claims: SessionClaims): Promise<string> {
  const key = new TextEncoder().encode(getSessionSecret());
  return new SignJWT({ email: claims.email, role: claims.role, purpose: WS_TOKEN_PURPOSE })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(SESSION_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${WS_TOKEN_TTL_SECONDS}s`)
    .sign(key);
}
