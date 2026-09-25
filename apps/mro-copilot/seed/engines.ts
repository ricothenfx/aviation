import { readFileSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";

import { createDb } from "../src/db/client";
import { engineUnits, sensorReadings } from "../src/db/schema";

/**
 * F4 fleet seed (data-model.md §7 seed order: "engines → C-MAPSS
 * sample/download → thresholds"). Sources, honestly labeled per unit:
 *
 * 1. `cmapss/data/test_FD001.txt` — the pinned, checksum-verified NASA FD001
 *    test split (present when download.sh has run). Units map to fictional
 *    ids NX-E101…NX-E200 (data-ethics §2).
 * 2. `cmapss/sample/test_FD001.sample.txt` — the committed synthetic 3-unit
 *    sample (always seeded so fixtures and the honesty case are hermetic):
 *    NX-E201 healthy · NX-E202 alert fixture · NX-E203 insufficient history.
 *
 * Deterministic synthetic time axis (data-model.md §8):
 *   recorded_at = 2000-01-01T00:00:00Z + cycle × 1 day (enforced by the
 *   migration's CHECK constraint). Maintenance-window threshold: 30 cycles
 *   for every unit (fleet-wide shop-visit planning margin).
 */

export const THRESHOLD_CYCLES = 30;
export const EPOCH_MS = Date.UTC(2000, 0, 1);

interface FleetFile {
  dataset: "cmapss-fd001" | "synthetic-sample";
  path: string;
  /** C-MAPSS unit number → fictional NX-E id. */
  toUnitId: (unit: number) => string;
}

function samplePath(): string {
  return path.join(import.meta.dirname, "cmapss", "sample", "test_FD001.sample.txt");
}

function realDataPath(): string {
  return path.join(import.meta.dirname, "cmapss", "data", "test_FD001.txt");
}

export function toRealUnitId(unit: number): string {
  return `NX-E1${String(unit).padStart(2, "0")}`;
}

export function toSampleUnitId(unit: number): string {
  return `NX-E${unit}`;
}

interface RawRow {
  unit: number;
  cycle: number;
  setting1: number;
  setting2: number;
  setting3: number;
  sensors: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
}

function parseCmapssFile(filePath: string): RawRow[] {
  const text = readFileSync(filePath, "utf8");
  const rows: RawRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 26) {
      throw new Error(`${filePath}: expected 26 columns, found ${parts.length}`);
    }
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) {
      throw new Error(`${filePath}: non-numeric field in "${trimmed}"`);
    }
    rows.push({
      unit: nums[0]!,
      cycle: nums[1]!,
      setting1: nums[2]!,
      setting2: nums[3]!,
      setting3: nums[4]!,
      sensors: nums.slice(5, 26) as RawRow["sensors"],
    });
  }
  if (rows.length === 0) throw new Error(`${filePath}: no data rows`);
  return rows;
}

/** Load the fleet: real FD001 test split when downloaded + the committed
 * synthetic sample. Returns per-unit rows sorted by cycle. */
export function loadFleet(): Map<string, RawRow[]> {
  const fleet = new Map<string, RawRow[]>();
  const sources: FleetFile[] = [
    { dataset: "synthetic-sample", path: samplePath(), toUnitId: toSampleUnitId },
  ];
  try {
    readFileSync(realDataPath(), "utf8");
    sources.unshift({
      dataset: "cmapss-fd001",
      path: realDataPath(),
      toUnitId: toRealUnitId,
    });
  } catch {
    // Real data not downloaded — hermetic CI/offline path uses the sample only.
  }
  for (const source of sources) {
    for (const row of parseCmapssFile(source.path)) {
      const unitId = source.toUnitId(row.unit);
      const list = fleet.get(unitId) ?? [];
      list.push(row);
      fleet.set(unitId, list);
    }
  }
  return fleet;
}

export async function seedEngines(): Promise<{ units: number; readings: number }> {
  const { db, close } = createDb();
  try {
    return await seedEnginesWith(db);
  } finally {
    await close();
  }
}

export async function seedEnginesWith(
  database: ReturnType<typeof createDb>["db"],
): Promise<{ units: number; readings: number }> {
  const fleet = loadFleet();
  const datasetByUnit = new Map<string, "cmapss-fd001" | "synthetic-sample">();
  for (const unitId of fleet.keys()) {
    datasetByUnit.set(unitId, unitId.startsWith("NX-E2") ? "synthetic-sample" : "cmapss-fd001");
  }

  // 1. Units (upsert — re-seeding never duplicates or flips thresholds).
  await database
    .insert(engineUnits)
    .values(
      [...fleet.keys()].map((unitId) => ({
        unitId,
        dataset: datasetByUnit.get(unitId)!,
        windowThresholdCycles: THRESHOLD_CYCLES,
        status: "active" as const,
      })),
    )
    .onConflictDoUpdate({
      target: engineUnits.unitId,
      set: { dataset: sql`excluded.dataset`, windowThresholdCycles: THRESHOLD_CYCLES },
    });

  // 2. Sensor history (idempotent: unique (unit, cycle, recorded_at)).
  const values = [...fleet.entries()].flatMap(([unitId, rows]) =>
    rows.map((r) => ({
      unitId,
      cycle: r.cycle,
      recordedAt: new Date(EPOCH_MS + r.cycle * 24 * 60 * 60 * 1000),
      setting1: r.setting1,
      setting2: r.setting2,
      setting3: r.setting3,
      s1: r.sensors[0],
      s2: r.sensors[1],
      s3: r.sensors[2],
      s4: r.sensors[3],
      s5: r.sensors[4],
      s6: r.sensors[5],
      s7: r.sensors[6],
      s8: r.sensors[7],
      s9: r.sensors[8],
      s10: r.sensors[9],
      s11: r.sensors[10],
      s12: r.sensors[11],
      s13: r.sensors[12],
      s14: r.sensors[13],
      s15: r.sensors[14],
      s16: r.sensors[15],
      s17: r.sensors[16],
      s18: r.sensors[17],
      s19: r.sensors[18],
      s20: r.sensors[19],
      s21: r.sensors[20],
    })),
  );

  let inserted = 0;
  const BATCH = 400;
  for (let i = 0; i < values.length; i += BATCH) {
    const batch = values.slice(i, i + BATCH);
    const result = await database
      .insert(sensorReadings)
      .values(batch)
      .onConflictDoNothing({
        target: [sensorReadings.unitId, sensorReadings.cycle, sensorReadings.recordedAt],
      })
      .returning({ unitId: sensorReadings.unitId });
    inserted += result.length;
  }

  return { units: fleet.size, readings: inserted };
}

export async function main(): Promise<void> {
  const result = await seedEngines();
  console.info(
    JSON.stringify({
      level: "info",
      module: "seed-engines",
      msg: "engine fleet seeded",
      units: result.units,
      sensorRows: result.readings,
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(
        JSON.stringify({
          level: "error",
          module: "seed-engines",
          msg: "engine seed failed",
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      process.exit(1);
    });
}
