/**
 * Seeded demo users (D-09). Accounts are fake from birth (data-ethics.md §5);
 * names are fictional and airline references use the invented brand NX / NordicX
 * (ui-design-system.md §8, data-ethics.md §2).
 *
 * Reference-day flights/stands/tasks arrive with the F2 schema — this skeleton
 * intentionally seeds only the auth surface.
 */
export interface SeedUser {
  email: string;
  displayName: string;
  role: "viewer" | "coordinator" | "supervisor";
  password: string;
}

export const SEED_USERS: SeedUser[] = [
  {
    email: "priya.nair@nx-sim.example",
    displayName: "Priya Nair",
    role: "supervisor",
    password: "supervisor-nx-01",
  },
  {
    email: "maya.tan@nx-sim.example",
    displayName: "Maya Tan",
    role: "coordinator",
    password: "coordinator-nx-01",
  },
  {
    email: "arif.rahman@nx-sim.example",
    displayName: "Arif Rahman",
    role: "viewer",
    password: "viewer-nx-01",
  },
];
