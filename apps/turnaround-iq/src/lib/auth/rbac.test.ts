import { describe, expect, it } from "vitest";

import { assertRole, roleAtLeast, type Role } from "./rbac";

describe("RBAC ladder (PRD F-7, D-09)", () => {
  it("orders viewer < coordinator < supervisor", () => {
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
    expect(roleAtLeast("viewer", "coordinator")).toBe(false);
    expect(roleAtLeast("coordinator", "viewer")).toBe(true);
    expect(roleAtLeast("coordinator", "coordinator")).toBe(true);
    expect(roleAtLeast("coordinator", "supervisor")).toBe(false);
    expect(roleAtLeast("supervisor", "viewer")).toBe(true);
    expect(roleAtLeast("supervisor", "coordinator")).toBe(true);
    expect(roleAtLeast("supervisor", "supervisor")).toBe(true);
  });

  it("assertRole throws for insufficient roles", () => {
    expect(() => assertRole("viewer" as Role, "coordinator")).toThrow(/FORBIDDEN/);
    expect(() => assertRole("coordinator", "supervisor")).toThrow(/FORBIDDEN/);
    expect(() => assertRole("supervisor", "coordinator")).not.toThrow();
  });
});
