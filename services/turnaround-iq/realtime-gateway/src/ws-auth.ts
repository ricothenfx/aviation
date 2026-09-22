import { jwtVerify } from "jose";
import { z } from "zod";

/**
 * Verification side of the ws handshake (architecture.md §5): the Next.js app
 * mints a short-lived HS256 token (issuer `turnaround-iq`, purpose `ws`, ≤ 60 s
 * TTL); this gateway verifies signature, issuer, purpose and expiry. Claim
 * contract shared with apps/turnaround-iq/src/lib/auth/jwt.ts.
 */

const wsClaimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(["viewer", "coordinator", "supervisor"]),
});

export interface WsTokenClaims {
  sub: string;
  email: string;
  role: "viewer" | "coordinator" | "supervisor";
}

export const WS_TOKEN_ISSUER = "turnaround-iq";
export const WS_TOKEN_PURPOSE = "ws";

/** ENV-provided signing secret, shared with the web app; no fallback (§7). */
export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("AUTH_SECRET is missing or too short (min 16 chars).");
  }
  return secret;
}

export async function verifySessionToken(token: string): Promise<WsTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(getAuthSecret()), {
      issuer: WS_TOKEN_ISSUER,
    });
    if (payload.purpose !== WS_TOKEN_PURPOSE) return null;
    const parsed = wsClaimsSchema.parse({
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
    });
    return parsed;
  } catch {
    return null;
  }
}
