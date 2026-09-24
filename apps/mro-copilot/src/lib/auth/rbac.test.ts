import { describe, expect, it } from "vitest";

import { ROLES, assertRole, roleAtLeast, type Role } from "./rbac";

/**
 * Role ladder matrix per PRD F-7 (DoD F1: RBAC test matrix
 * viewer/engineer/reviewer). The ladder is the enforcement primitive used by
 * requireSession in every route handler.
 */
describe("rbac role ladder", () => {
  const expected: Record<Role, number> = { viewer: 0, engineer: 1, reviewer: 2 };

  it("exposes exactly the three PRD roles", () => {
    expect(ROLES).toEqual(["viewer", "engineer", "reviewer"]);
  });

  it("roleAtLeast holds for the full 3×3 matrix", () => {
    for (const role of ROLES) {
      for (const minimum of ROLES) {
        expect(roleAtLeast(role, minimum)).toBe(expected[role] >= expected[minimum]);
      }
    }
  });

  it("viewer cannot act as engineer or reviewer", () => {
    expect(roleAtLeast("viewer", "engineer")).toBe(false);
    expect(roleAtLeast("viewer", "reviewer")).toBe(false);
    expect(() => assertRole("viewer", "engineer")).toThrow(/FORBIDDEN.*engineer/);
    expect(() => assertRole("viewer", "reviewer")).toThrow(/FORBIDDEN.*reviewer/);
  });

  it("engineer can act as viewer but not reviewer", () => {
    expect(roleAtLeast("engineer", "viewer")).toBe(true);
    expect(roleAtLeast("engineer", "reviewer")).toBe(false);
    expect(() => assertRole("engineer", "reviewer")).toThrow(/FORBIDDEN.*reviewer/);
  });

  it("reviewer can act at every level", () => {
    expect(roleAtLeast("reviewer", "viewer")).toBe(true);
    expect(roleAtLeast("reviewer", "engineer")).toBe(true);
    expect(roleAtLeast("reviewer", "reviewer")).toBe(true);
    expect(() => assertRole("reviewer", "reviewer")).not.toThrow();
  });
});
