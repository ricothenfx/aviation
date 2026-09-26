import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { SESSION_ISSUER, getSessionSecret, signSessionToken, verifySessionToken } from "./jwt";

/**
 * Session token contract (rebook-ai architecture.md §5): issuer pinned to
 * rebook-ai, claims zod-validated, tampered/expired tokens rejected as
 * UNAUTHENTICATED — never as a 500. The unit lane injects a throwaway secret
 * (engineering-standards.md §7: no secrets in repo, CI uses dummy values).
 */

const SECRET = "unit-test-secret-0123456789abcdef";

function withSecret(env: Record<string, string | undefined>): void {
  for (const key of ["REBOOK_AUTH_SECRET", "AUTH_SECRET"]) {
    process.env[key] = env[key];
  }
}

afterEach(() => {
  delete process.env.REBOOK_AUTH_SECRET;
  delete process.env.AUTH_SECRET;
});

describe("jwt sessions", () => {
  const claims = {
    sub: "0d5c1e59-cc2d-4cfe-b7c9-3573c3ef1a2e",
    email: "nadia.cho@pax-sim.example",
    name: "Nadia Cho",
    role: "passenger" as const,
  };

  it("round-trips valid claims", async () => {
    withSecret({ REBOOK_AUTH_SECRET: SECRET });
    const token = await signSessionToken(claims);
    const parsed = await verifySessionToken(token);
    expect(parsed).toMatchObject(claims);
  });

  it("pins the rebook-ai issuer (cookie-jar separation from sibling apps)", async () => {
    withSecret({ REBOOK_AUTH_SECRET: SECRET });
    const foreign = await new SignJWT({ email: claims.email, name: claims.name, role: "agent" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.sub)
      .setIssuer("mro-copilot")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(getSessionSecret()));
    await expect(verifySessionToken(foreign)).rejects.toThrow(/invalid or expired session/);
    expect(SESSION_ISSUER).toBe("rebook-ai");
  });

  it("rejects garbage tokens with the API error shape", async () => {
    withSecret({ REBOOK_AUTH_SECRET: SECRET });
    await expect(verifySessionToken("not-a-token")).rejects.toThrow(/invalid or expired session/);
  });

  it("rejects claims with an undocumented role (server-side RBAC basis)", async () => {
    withSecret({ REBOOK_AUTH_SECRET: SECRET });
    const forged = await new SignJWT({ email: claims.email, name: claims.name, role: "crew" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.sub)
      .setIssuer(SESSION_ISSUER)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(getSessionSecret()));
    await expect(verifySessionToken(forged)).rejects.toThrow();
  });

  it("refuses to sign without a configured secret (no silent fallback)", () => {
    withSecret({});
    expect(() => getSessionSecret()).toThrow(/REBOOK_AUTH_SECRET \(or AUTH_SECRET\)/);
  });
});
