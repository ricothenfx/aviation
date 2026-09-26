import { describe, expect, it } from "vitest";

import { ROLES, assertRole, roleAtLeast } from "./rbac";

/** PRD F-7 ladder: passenger < agent < supervisor. */

describe("rbac ladder", () => {
  it("orders the documented ladder strictly", () => {
    expect(ROLES).toEqual(["passenger", "agent", "supervisor"]);
    expect(roleAtLeast("passenger", "passenger")).toBe(true);
    expect(roleAtLeast("passenger", "agent")).toBe(false);
    expect(roleAtLeast("agent", "passenger")).toBe(true);
    expect(roleAtLeast("agent", "supervisor")).toBe(false);
    expect(roleAtLeast("supervisor", "agent")).toBe(true);
    expect(roleAtLeast("supervisor", "supervisor")).toBe(true);
  });

  it("assertRole throws on violation (server-side enforcement)", () => {
    expect(() => assertRole("passenger", "agent")).toThrow(/requires agent/);
    expect(() => assertRole("agent", "supervisor")).toThrow(/requires supervisor/);
    expect(() => assertRole("supervisor", "supervisor")).not.toThrow();
  });
});
