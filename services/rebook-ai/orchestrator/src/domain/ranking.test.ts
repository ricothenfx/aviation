import { describe, expect, it } from "vitest";

import { loadInventory, loadPolicy, seedDir } from "rebook-ai/seed-fixtures";

import {
  eligibleCandidates,
  offerSetHash,
  rankOffers,
  type DisruptionContext,
  type RankOffersInput,
  type RankingPnr,
} from "./ranking";

/**
 * Ranking engine tests (F2 DoD: ranking determinism hash assert). Fixtures
 * derive from the committed seed files (data-model.md §6) — the AMS candidate
 * pool is exactly what the demo disruption of NX 288 sees.
 */

const NOW = new Date("2026-10-15T09:20:00+08:00");

const DISRUPTION: DisruptionContext = {
  flightNo: "NX 288",
  origin: "SIN",
  dest: "AMS",
  schedDep: "2026-10-15T09:15:00+08:00",
  schedArr: "2026-10-15T22:15:00+08:00",
  kind: "cancellation",
  delayMinutes: 0,
  reasonCode: "SIM-CANCEL-01",
};

const PNR: RankingPnr = {
  id: "00000000-0000-4000-8000-000000000001",
  locator: "NXQ4ZK",
  tier: "gold",
  fareClass: "Y",
  partySize: 1,
  refundable: false,
  changeable: true,
};

function input(overrides: Partial<RankOffersInput> = {}): RankOffersInput {
  return {
    pnr: PNR,
    disruption: DISRUPTION,
    inventory: loadInventory(seedDir()).candidates,
    policy: loadPolicy(seedDir()),
    now: NOW,
    ...overrides,
  };
}

describe("offer ranking engine (PRD F-2, F2 DoD)", () => {
  it("is deterministic: same disruption + inventory ⇒ identical ranked set + hash", () => {
    const first = rankOffers(input());
    const second = rankOffers(input());
    expect(second.options).toEqual(first.options);
    expect(second.rankingHash).toBe(first.rankingHash);
    expect(first.rankingHash).toBe(offerSetHash(first.options));
    // A different inventory snapshot ⇒ a different hash (the assert has teeth).
    const otherInventory = loadInventory(seedDir()).candidates.filter(
      (candidate) => candidate.airline === "NX",
    );
    expect(rankOffers(input({ inventory: otherInventory })).rankingHash).not.toBe(
      first.rankingHash,
    );
  });

  it("ranks fast/cheap/flexible with per-rank reasons over the AMS pool", () => {
    const { options } = rankOffers(input());
    expect(options.map((o) => o.kind)).toEqual(["fast", "cheap", "flexible"]);
    // Fast: SV 1102 arrives 01:00 (D+1) — earliest arrival in the pool.
    expect(options[0]?.segments[0]?.flightNo).toBe("SV 1102");
    expect(options[0]?.interline).toBe(true);
    expect(options[0]?.reason).toContain("Earliest arrival 01:00");
    // Cheap: NX 211 has the lowest fare delta (SGD 60).
    expect(options[1]?.segments[0]?.flightNo).toBe("NX 211");
    expect(options[1]?.fareDelta).toBe(60);
    expect(options[1]?.reason).toContain("SGD 60");
    expect(options[1]?.reason).toContain("gold policy cap");
    // Flexible: NX 208 is refundable + changeable on the same carrier.
    expect(options[2]?.segments[0]?.flightNo).toBe("NX 208");
    expect(options[2]?.refundable).toBe(true);
    expect(options[2]?.interline).toBe(false);
    expect(options[2]?.reason).toContain("refundable and changeable");
  });

  it("applies tier fare caps: an above-cap pool flags overCap for agent review", () => {
    const tightPolicy = {
      ...loadPolicy(seedDir()),
      fareCaps: { standard: 50, silver: 50, gold: 50 },
    };
    const { options } = rankOffers(input({ policy: tightPolicy }));
    const cheap = options.find((o) => o.kind === "cheap");
    expect(cheap).toBeDefined();
    expect(cheap?.overCap).toBe(true);
    expect(cheap?.reason).toContain("above your");
    expect(cheap?.reason).toContain("agent review");
  });

  it("filters candidates by party size against seats left", () => {
    const big = rankOffers(input({ pnr: { ...PNR, partySize: 10 } }));
    const fast = big.options.find((o) => o.kind === "fast");
    // SV 1102 has 9 seats — a party of 10 must not be offered it.
    expect(fast?.segments[0]?.flightNo).not.toBe("SV 1102");
    expect(fast?.segments[0]?.flightNo).toBe("NX 208");
  });

  it("never offers departures before the original slot (PRD §6)", () => {
    const candidates = eligibleCandidates(input());
    for (const candidate of candidates) {
      expect(Date.parse(candidate.depart)).toBeGreaterThanOrEqual(Date.parse(DISRUPTION.schedDep));
    }
  });

  it("offers nothing (honestly) when no candidate matches the route", () => {
    const { options } = rankOffers(
      input({
        disruption: { ...DISRUPTION, dest: "YYZ" },
      }),
    );
    expect(options).toEqual([]);
  });
});
