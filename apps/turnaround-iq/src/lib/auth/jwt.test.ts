import { describe, expect, it } from "vitest";

import { ApiError, loginRequestSchema } from "@aviation/contracts";

import { signSessionToken, verifySessionToken } from "./jwt";

describe("JWT session tokens (D-09)", () => {
  const secret = "test-secret-0123456789-0123456789abcdef";

  function withSecret<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = secret;
    return fn().finally(() => {
      if (previous === undefined) {
        delete process.env.AUTH_SECRET;
      } else {
        process.env.AUTH_SECRET = previous;
      }
    });
  }

  const claims = {
    sub: "0d5c1e59-cc2d-4cfe-b7c9-3573c3ef1a2e",
    email: "maya.tan@nx-sim.example",
    name: "Maya Tan",
    role: "coordinator" as const,
  };

  it("round-trips claims", async () => {
    await withSecret(async () => {
      const token = await signSessionToken(claims);
      const verified = await verifySessionToken(token);
      expect(verified).toMatchObject(claims);
    });
  });

  it("rejects tampered tokens as UNAUTHENTICATED", async () => {
    await withSecret(async () => {
      const token = await signSessionToken(claims);
      const tampered = `${token}x`;
      await expect(verifySessionToken(tampered)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    });
  });

  it("refuses to run without AUTH_SECRET", async () => {
    await withSecret(async () => {
      delete process.env.AUTH_SECRET;
      await expect(signSessionToken(claims)).rejects.toThrow(/AUTH_SECRET/);
    });
  });
});

describe("login contract", () => {
  it("rejects malformed bodies with the documented envelope", () => {
    const result = loginRequestSchema.safeParse({ email: "nope", password: "" });
    expect(result.success).toBe(false);
    expect(new ApiError("VALIDATION_ERROR", "bad body").status).toBe(400);
  });
});
