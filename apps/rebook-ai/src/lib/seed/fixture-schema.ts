import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Zod schemas for the committed seed fixtures (rebook-ai data-model.md §4):
 * reference-day.json (schedule), pnrs.json (~40 synthetic bookings incl. the
 * demo cast), inventory.json (rebookable candidate segments) and policy.json
 * (voucher criteria, fare caps, offer TTL). Both the app seed (`pnpm
 * seed:rebook`) and the orchestrator (ranking + policy inputs) load fixtures
 * through this module so the shapes have exactly one source of truth.
 * Fixtures are fictional from birth (data-ethics.md §2).
 */

export const seedFlightSchema = z.object({
  airline: z.string().min(2).max(2),
  flightNo: z.string().min(1),
  origin: z.string().length(3),
  dest: z.string().length(3),
  schedDep: z.string().datetime({ offset: true }),
  schedArr: z.string().datetime({ offset: true }),
  aircraft: z.string().min(1),
  status: z.enum(["scheduled", "delayed", "cancelled"]).default("scheduled"),
  delayMinutes: z.number().int().nonnegative().default(0),
});
export type SeedFlight = z.infer<typeof seedFlightSchema>;

export const seedReferenceDaySchema = z.object({
  referenceDay: z.string().min(1),
  timezone: z.string().min(1),
  flights: z.array(seedFlightSchema).min(1),
});
export type SeedReferenceDay = z.infer<typeof seedReferenceDaySchema>;

export const seedSegmentSchema = z.object({
  airline: z.string().min(2).max(2),
  flightNo: z.string().min(1),
  flightDate: z.string().datetime({ offset: true }),
  origin: z.string().length(3),
  dest: z.string().length(3),
  cabin: z.string().min(1),
  status: z.enum(["confirmed", "delayed", "cancelled", "rebooked"]).default("confirmed"),
});
export type SeedSegment = z.infer<typeof seedSegmentSchema>;

export const seedPnrSchema = z.object({
  locator: z.string().length(6),
  /** Seeded-login linkage (D-09); null for background PNRs without a login. */
  email: z.string().email().nullable(),
  passengerName: z.string().min(1),
  tier: z.enum(["standard", "silver", "gold"]),
  fareClass: z.string().min(1),
  partySize: z.number().int().positive(),
  contactHandle: z.string().min(1),
  segments: z.array(seedSegmentSchema).min(1),
  document: z.record(z.string(), z.unknown()),
});
export type SeedPnr = z.infer<typeof seedPnrSchema>;

export const seedPnrsSchema = z.object({
  referenceDay: z.string().min(1),
  pnrs: z.array(seedPnrSchema).min(1),
});
export type SeedPnrs = z.infer<typeof seedPnrsSchema>;

export const seedInventoryCandidateSchema = z.object({
  airline: z.string().min(2).max(2),
  flightNo: z.string().min(1),
  origin: z.string().length(3),
  dest: z.string().length(3),
  depart: z.string().datetime({ offset: true }),
  arrive: z.string().datetime({ offset: true }),
  cabin: z.string().min(1),
  seatsLeft: z.number().int().nonnegative(),
  fareDelta: z.number().int().nonnegative(),
  refundable: z.boolean(),
  changeable: z.boolean(),
  interline: z.boolean(),
});
export type SeedInventoryCandidate = z.infer<typeof seedInventoryCandidateSchema>;

export const seedInventorySchema = z.object({
  referenceDay: z.string().min(1),
  candidates: z.array(seedInventoryCandidateSchema).min(1),
});
export type SeedInventory = z.infer<typeof seedInventorySchema>;

export const seedPolicySchema = z.object({
  currency: z.string().min(1),
  voucher: z.object({
    cancellation: z.object({ baseAmount: z.number().int().positive(), reason: z.string().min(1) }),
    longDelay: z.object({
      thresholdMinutes: z.number().int().positive(),
      amount: z.number().int().positive(),
      reason: z.string().min(1),
    }),
    tierBonus: z.object({
      gold: z.number().int(),
      silver: z.number().int(),
      standard: z.number().int(),
    }),
    maxAmount: z.number().int().positive(),
  }),
  fareCaps: z.object({
    standard: z.number().int(),
    silver: z.number().int(),
    gold: z.number().int(),
  }),
  offer: z.object({
    ttlMinutes: z.number().int().positive(),
    maxOptions: z.number().int().positive(),
  }),
  disruption: z.object({ longDelayMinutes: z.number().int().positive() }),
});
export type SeedPolicy = z.infer<typeof seedPolicySchema>;

/**
 * Seed directory resolution. `REBOOK_SEED_DIR` wins (compose sets it
 * explicitly). Fallbacks: tsx/node resolve `import.meta.dirname` to the real
 * file path (seed script, orchestrator), but Next.js webpack server bundles
 * leave it undefined — there we fall back to the process cwd, which is the
 * app root for both `pnpm dev` and the containerized `next start`.
 */
export function seedDir(override: string | undefined = process.env.REBOOK_SEED_DIR): string {
  const candidates = [
    override,
    import.meta.dirname ? path.resolve(import.meta.dirname, "../../../seed") : undefined,
    path.resolve(process.cwd(), "seed"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "policy.json"))) return candidate;
  }
  throw new Error(
    `seed fixtures not found — looked in: ${candidates.join(", ")} (set REBOOK_SEED_DIR)`,
  );
}

function readFixture(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
}

export function loadReferenceDay(dir: string = seedDir()): SeedReferenceDay {
  return seedReferenceDaySchema.parse(readFixture(dir, "reference-day.json"));
}
export function loadPnrs(dir: string = seedDir()): SeedPnrs {
  return seedPnrsSchema.parse(readFixture(dir, "pnrs.json"));
}
export function loadInventory(dir: string = seedDir()): SeedInventory {
  return seedInventorySchema.parse(readFixture(dir, "inventory.json"));
}
export function loadPolicy(dir: string = seedDir()): SeedPolicy {
  return seedPolicySchema.parse(readFixture(dir, "policy.json"));
}
