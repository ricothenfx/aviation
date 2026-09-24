/** RBAC role ladder per PRD F-7 / D-09: viewer < engineer < reviewer. */

export const ROLES = ["viewer", "engineer", "reviewer"] as const;

export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = {
  viewer: 0,
  engineer: 1,
  reviewer: 2,
};

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

export function assertRole(role: Role, minimum: Role): void {
  if (!roleAtLeast(role, minimum)) {
    throw new Error(`FORBIDDEN: requires ${minimum}, has ${role}`);
  }
}
