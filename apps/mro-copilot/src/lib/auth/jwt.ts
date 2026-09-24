import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";

import { ApiError } from "@aviation/contracts";

/**
 * JWT session tokens for the local auth provider (D-09). Edge-safe (jose +
 * WebCrypto) so middleware can verify sessions without Node APIs. Issuer and
 * cookie name are mro-copilot-specific: turnaround-iq and this app share the
 * localhost cookie jar, so names must never collide.
 */

export const SESSION_ISSUER = "mro-copilot";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/** httpOnly session cookie name; override via MRO_AUTH_COOKIE_NAME. */
export const SESSION_COOKIE_NAME = process.env.MRO_AUTH_COOKIE_NAME ?? "mro_session";

const claimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["viewer", "engineer", "reviewer"]),
});

export type SessionClaims = z.infer<typeof claimsSchema>;

/** ENV-provided signing secret; no fallback by design (engineering-standards.md §7). */
export function getSessionSecret(): string {
  const secret = process.env.MRO_AUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "MRO_AUTH_SECRET (or AUTH_SECRET) is missing or too short (min 16 chars). " +
        "Copy .env.example to .env and generate one.",
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
