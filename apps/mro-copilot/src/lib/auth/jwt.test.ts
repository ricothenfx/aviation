import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "@aviation/contracts";

import {
  SESSION_COOKIE_NAME,
  SESSION_ISSUER,
  getSessionSecret,
  signSessionToken,
  verifySessionToken,
} from "./jwt";

const SECRET = "unit-test-secret-0123456789abcdef";

function withSecret(env: Record<string, string | undefined>): void {
  for (const key of ["MRO_AUTH_SECRET", "AUTH_SECRET"]) {
    process.env[key] = env[key];
  }
}

afterEach(() => {
  delete process.env.MRO_AUTH_SECRET;
  delete process.env.AUTH_SECRET;
});

describe("session tokens", () => {
  it("round-trips claims through sign/verify", async () => {
    withSecret({ MRO_AUTH_SECRET: SECRET });
    const token = await signSessionToken({
      sub: "0b8f6c1e-0000-4000-8000-000000000001",
      email: "siti.rahayu@mro-sim.example",
      name: "Siti Rahayu",
      role: "engineer",
    });
    const claims = await verifySessionToken(token);
    expect(claims).toMatchObject({
      sub: "0b8f6c1e-0000-4000-8000-000000000001",
      email: "siti.rahayu@mro-sim.example",
      name: "Siti Rahayu",
      role: "engineer",
    });
  });

  it("rejects tokens from another issuer (turnaround-iq tokens must not authenticate here)", async () => {
    withSecret({ MRO_AUTH_SECRET: SECRET });
    const foreign = await new SignJWT({ email: "x@mro-sim.example", role: "viewer" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("0b8f6c1e-0000-4000-8000-000000000002")
      .setIssuer("turnaround-iq")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifySessionToken(foreign)).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects garbage and tampered tokens", async () => {
    withSecret({ MRO_AUTH_SECRET: SECRET });
    await expect(verifySessionToken("not-a-jwt")).rejects.toBeInstanceOf(ApiError);
    const token = await signSessionToken({
      sub: "0b8f6c1e-0000-4000-8000-000000000003",
      email: "tom.ng@mro-sim.example",
      name: "Tom Ng",
      role: "viewer",
    });
    await expect(verifySessionToken(`${token}x`)).rejects.toBeInstanceOf(ApiError);
  });

  it("fails loudly without a signing secret (no insecure fallback)", async () => {
    withSecret({});
    expect(() => getSessionSecret()).toThrow(/MRO_AUTH_SECRET/);
    await expect(
      signSessionToken({
        sub: "0b8f6c1e-0000-4000-8000-000000000004",
        email: "wei.lim@mro-sim.example",
        name: "Wei Lim",
        role: "reviewer",
      }),
    ).rejects.toThrow(/MRO_AUTH_SECRET/);
  });

  it("uses an mro-specific cookie name and issuer", () => {
    expect(SESSION_COOKIE_NAME).toBe("mro_session");
    expect(SESSION_ISSUER).toBe("mro-copilot");
  });
});
