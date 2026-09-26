// One-off generator for apps/rebook-ai/seed/{reference-day,pnrs,inventory}.json
// (rebook-ai data-model.md §4). Deterministic: fixed date, no randomness.
// Output is committed; re-run only to regenerate the reference fixtures.
import { writeFileSync } from "node:fs";

const DAY = "2026-10-15"; // reference day (fictional; all times UTC+8)
const NEXT = "2026-10-16"; // overnight arrivals land on D+1
const TZ = "+08:00";
const pad = (n) => String(n).padStart(2, "0");
const isoOn = (day, h, m) => `${day}T${pad(h)}:${pad(m)}:00${TZ}`;

const DESTS = [
  ["AMS", 13.0, "A350-900"],
  ["LHR", 13.5, "A380-800"],
  ["HND", 7.0, "B787-9"],
  ["SYD", 8.0, "A350-900"],
  ["FRA", 12.5, "A350-900"],
  ["CDG", 13.0, "B777-300ER"],
  ["MEL", 7.7, "B787-9"],
  ["BKK", 2.3, "B737-8"],
  ["HKG", 3.8, "A321neo"],
  ["ICN", 6.5, "A330-900"],
  ["DPS", 2.6, "B737-8"],
  ["PER", 5.2, "B737-8"],
  ["AKL", 10.3, "B787-9"],
  ["DOH", 7.7, "A350-900"],
  ["JNB", 10.3, "A350-900"],
  ["CPT", 11.3, "A350-900"],
  ["SFO", 14.5, "A350-1000"],
  ["LAX", 14.2, "A380-800"],
  ["PEK", 6.2, "A330-900"],
  ["PVG", 5.5, "A330-900"],
  ["MNL", 3.6, "A321neo"],
  ["CGK", 1.8, "B737-8"],
  ["KUL", 1.0, "B737-8"],
  ["BOM", 5.5, "B737-8"],
  ["DEL", 5.5, "B787-9"],
];

/** Depart + duration → { schedDep, schedArr } with day rollover for overnights. */
function window(depH, depM, durationMin) {
  const arrTotal = depH * 60 + depM + durationMin;
  const nextDay = arrTotal >= 1440;
  const arrH = Math.floor(arrTotal / 60) % 24;
  const arrM = arrTotal % 60;
  return {
    schedDep: isoOn(DAY, depH, depM),
    schedArr: isoOn(nextDay ? NEXT : DAY, arrH, arrM),
  };
}

// One synthetic departure bank (data-model.md §4): NX 200–899, SV 1000–1499, BH 2000–2399.
function block(prefix, start, count, step, airline, aircraftPool) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const [dest, durH, defAircraft] = DESTS[i % DESTS.length];
    const slot = 6 + Math.floor((i * 17.7) % 17) * 0.5 + (i % 2) * 0.25; // 06:00–23:45 grid
    const h = Math.floor(slot);
    const m = Math.round(((slot - h) * 60) / 5) * 5;
    rows.push({
      airline,
      flightNo: `${prefix} ${start + i * step}`,
      origin: "SIN",
      dest,
      ...window(h, m, Math.round(durH * 60)),
      aircraft: aircraftPool[i % aircraftPool.length] ?? defAircraft,
      status: "scheduled",
      delayMinutes: 0,
    });
  }
  return rows;
}

const schedule = [
  ...block("NX", 200, 40, 3, "NX", ["A350-900", "B787-9", "A380-800"]),
  // Demo anchor flight (demo-script.md): NX 288 SIN→AMS departing 09:15.
  // 288 is not on the 200+3k grid, so no collision with the generated block.
  {
    airline: "NX",
    flightNo: "NX 288",
    origin: "SIN",
    dest: "AMS",
    ...window(9, 15, 780),
    aircraft: "A350-900",
    status: "scheduled",
    delayMinutes: 0,
  },
  ...block("SV", 1000, 40, 13, "SV", ["A320neo", "B737-8", "A321neo"]),
  ...block("BH", 2000, 39, 10, "BH", ["B737-8", "A320neo", "E190-E2"]),
];

// ---- inventory: rebookable candidate segments (data-model.md §4) ------------
// SIN→AMS pool powers the demo scenario (NX 288 cancellation); secondary routes
// keep other injections honest. Partner rows (SV/BH) are interline-style.
function inv(airline, flightNo, dest, depH, depM, durationMin, seats, fareDelta, flags) {
  return {
    airline,
    flightNo,
    origin: "SIN",
    dest,
    depart: isoOn(DAY, depH, depM),
    arrive: window(depH, depM, durationMin).schedArr,
    cabin: "economy",
    seatsLeft: seats,
    fareDelta,
    refundable: flags.includes("refundable"),
    changeable: flags.includes("changeable"),
    interline: airline !== "NX",
  };
}

const inventory = [
  // SIN → AMS, ~13 h (NX 288 route — demo)
  inv("SV", "SV 1102", "AMS", 11, 30, 810, 9, 210, []),
  inv("BH", "BH 2004", "AMS", 16, 5, 800, 18, 150, ["changeable"]),
  inv("SV", "SV 1120", "AMS", 19, 40, 810, 6, 95, []),
  inv("NX", "NX 208", "AMS", 12, 40, 810, 14, 260, ["refundable", "changeable"]),
  inv("NX", "NX 211", "AMS", 23, 45, 810, 24, 60, ["changeable"]),
  // SIN → LHR, ~13.5 h (NX 218 route)
  inv("NX", "NX 223", "LHR", 22, 30, 810, 30, 90, ["changeable"]),
  inv("SV", "SV 1206", "LHR", 13, 15, 820, 11, 230, []),
  inv("BH", "BH 2102", "LHR", 17, 20, 815, 16, 180, ["changeable"]),
  inv("NX", "NX 229", "LHR", 10, 10, 810, 8, 310, ["refundable", "changeable"]),
  // SIN → HND, ~7 h (NX 234 route)
  inv("NX", "NX 232", "HND", 21, 15, 420, 40, 70, ["changeable"]),
  inv("SV", "SV 1302", "HND", 12, 30, 420, 12, 150, []),
  inv("BH", "BH 2204", "HND", 15, 45, 420, 20, 120, ["changeable"]),
  inv("NX", "NX 241", "HND", 9, 20, 420, 10, 240, ["refundable", "changeable"]),
  // SIN → SYD, ~8 h (NX 250 route)
  inv("NX", "NX 253", "SYD", 22, 40, 480, 26, 85, ["changeable"]),
  inv("SV", "SV 1402", "SYD", 14, 10, 480, 9, 200, []),
  inv("BH", "BH 2302", "SYD", 18, 5, 480, 21, 140, ["changeable"]),
  // SIN → FRA, ~12.5 h (NX 262 route)
  inv("NX", "NX 265", "FRA", 23, 20, 750, 18, 100, ["changeable"]),
  inv("SV", "SV 1444", "FRA", 13, 40, 755, 7, 220, []),
  inv("BH", "BH 2344", "FRA", 17, 55, 750, 15, 160, ["changeable"]),
];

// ---- PNRs (~40, synthetic; demo cast per demo-script.md) --------------------
// Every segment references a REAL flight from the generated schedule: dest +
// flightDate come from the schedule map, never hand-typed (fixture honesty).
const scheduleByFlightNo = new Map(schedule.map((f) => [f.flightNo, f]));
const nxByDest = new Map();
for (const flight of schedule) {
  if (flight.airline === "NX" && !nxByDest.has(flight.dest)) {
    nxByDest.set(flight.dest, flight);
  }
}
function nxTo(dest) {
  const flight = nxByDest.get(dest);
  if (!flight) throw new Error(`no NX flight to ${dest} in the generated schedule`);
  return [flight.flightNo, "SIN", dest, flight.schedDep];
}
const AMS = (flightNo) => {
  const flight = scheduleByFlightNo.get(flightNo);
  if (!flight) throw new Error(`unknown demo flight ${flightNo}`);
  return [flightNo, "SIN", flight.dest, flight.schedDep];
};
const LHR = (flightNo) => AMS(flightNo);
const HND = (flightNo) => AMS(flightNo);
const SYD = (flightNo) => AMS(flightNo);
const FRA = (flightNo) => AMS(flightNo);
const REFUNDABLE = { refundable: false, changeable: true, changeFee: 90 };

let handleSeq = 0;
function pnr(locator, name, tier, fareClass, partySize, segs, doc) {
  handleSeq += 1;
  return {
    locator,
    email: null, // seeded login linkage; resolved by seed.ts for the demo cast
    passengerName: name,
    tier,
    fareClass,
    partySize,
    contactHandle: `handle-p${String(handleSeq).padStart(2, "0")}@pax-sim.invalid`,
    segments: segs.map(([flightNo, origin, dest, schedDep]) => ({
      airline: flightNo.split(" ")[0],
      flightNo,
      flightDate: schedDep,
      origin,
      dest,
      cabin: "economy",
      status: "confirmed",
    })),
    document: {
      fareRules: { ...REFUNDABLE, ...(doc?.fareRules ?? {}) },
      ssr: doc?.ssr ?? [],
      loyalty: { program: "NX TopTier", balance: 1200 + handleSeq * 37, ...(doc?.loyalty ?? {}) },
    },
  };
}

const pnrs = [
  // Demo cast: Nadia Cho, gold, NX 288 (cancellation target)
  {
    ...pnr("NXQ4ZK", "Nadia Cho", "gold", "Y", 1, [AMS("NX 288", 9, 15)], {
      loyalty: { balance: 48250 },
    }),
    email: "nadia.cho@pax-sim.example",
  },
  // Families + interline-eligible + tier mix on the demo flight (13 more)
  pnr("NXK7P2", "Wei Lim Family", "standard", "Y", 4, [AMS("NX 288", 9, 15)], { ssr: ["UMNR-1"] }),
  pnr("NXM3TD", "Priya Raman", "silver", "B", 2, [AMS("NX 288", 9, 15)], { ssr: ["MEAL_AVML"] }),
  pnr("NXA9QF", "Jonas Berg", "standard", "M", 1, [AMS("NX 288", 9, 15)], {}),
  pnr("NXT5HL", "Amara Okafor", "gold", "Y", 2, [AMS("NX 288", 9, 15)], {}),
  pnr("NXC8RR", "Diego Santos", "standard", "Y", 3, [AMS("NX 288", 9, 15)], { ssr: ["WCHR"] }),
  pnr("NXB2NV", "Hana Yusof", "silver", "Y", 1, [AMS("NX 288", 9, 15)], {}),
  pnr("NXD6WJ", "Tomas Novak", "standard", "B", 2, [AMS("NX 288", 9, 15)], {}),
  pnr("NXF4KG", "Ingrid Halvorsen", "standard", "Y", 1, [AMS("NX 288", 9, 15)], {}),
  pnr("NXG1PS", "Ravi Chandran", "silver", "M", 2, [AMS("NX 288", 9, 15)], {}),
  pnr("NXH7ZL", "Mei Ling Wong", "gold", "C", 1, [AMS("NX 288", 9, 15)], {
    fareRules: { refundable: true, changeable: true, changeFee: 0 },
  }),
  pnr("NXJ3BV", "Oliver Bennett", "standard", "Y", 2, [AMS("NX 288", 9, 15)], {}),
  pnr("NXK9MD", "Fatima Al-Sayed", "standard", "Y", 5, [AMS("NX 288", 9, 15)], {
    ssr: ["MEAL_MOML", "UMNR-1"],
  }),
  pnr("NXL5NR", "Kenji Sato", "silver", "Y", 1, [AMS("NX 288", 9, 15)], {}),
  // Background disruption surface on other routes
  {
    ...pnr("NXM8QT", "Sofia Rossi", "standard", "Y", 2, [LHR(nxTo("LHR")[0])], {}),
    email: "sofia.rossi@pax-sim.example",
  },
  pnr("NXN2WX", "Liam Byrne", "silver", "B", 1, [LHR(nxTo("LHR")[0])], {}),
  pnr("NXP6ZC", "Aisha Rahman", "gold", "Y", 3, [LHR(nxTo("LHR")[0])], {}),
  pnr("NXQ4VJ", "Noah Klein", "standard", "M", 1, [LHR(nxTo("LHR")[0])], {}),
  pnr("NXR7DH", "Chloe Dubois", "standard", "Y", 2, [HND(nxTo("HND")[0])], {}),
  pnr("NXS1FK", "Arjun Mehta", "silver", "Y", 1, [HND(nxTo("HND")[0])], {}),
  pnr("NXT9LP", "Grace Wu", "standard", "Y", 4, [HND(nxTo("HND")[0])], { ssr: ["WCHR"] }),
  pnr("NXV3BN", "Erik Johansson", "standard", "B", 2, [SYD(nxTo("SYD")[0])], {}),
  pnr("NXW6YR", "Isabella Ferrari", "silver", "Y", 2, [SYD(nxTo("SYD")[0])], {}),
  pnr("NXX0GH", "Daniel Mwangi", "standard", "Y", 1, [FRA(nxTo("FRA")[0])], {}),
  pnr("NXY5KM", "Yuki Nakamura", "gold", "C", 1, [FRA(nxTo("FRA")[0])], {
    fareRules: { refundable: true, changeable: true, changeFee: 0 },
  }),
  // Quiet bookings on undisturbed flights (realistic reference day)
  pnr("NXZ2PQ", "Anya Petrova", "standard", "Y", 1, [nxTo("BKK")], {}),
  pnr("NYA8LT", "Marcus Chen", "silver", "Y", 2, [nxTo("HKG")], {}),
  pnr("NYB3RV", "Leila Hassan", "standard", "M", 3, [nxTo("ICN")], {}),
  pnr("NYC7XW", "Pablo Ortega", "standard", "Y", 1, [nxTo("DPS")], {}),
  pnr("NYD1ZJ", "Emma Wilson", "gold", "B", 2, [nxTo("PER")], {}),
  pnr("NYE4QD", "Kim Min-jun", "standard", "Y", 1, [nxTo("AKL")], {}),
  pnr("NYF8SN", "Zara Ahmed", "silver", "Y", 2, [nxTo("DOH")], {}),
  pnr("NYG2TF", "Lucas Meyer", "standard", "M", 1, [nxTo("JNB")], {}),
  pnr("NYH6BK", "Nadia Rahman", "standard", "Y", 3, [nxTo("CPT")], {}),
  pnr("NYJ0MV", "Chen Jiahui", "silver", "C", 1, [nxTo("SFO")], {}),
  pnr("NYK4PR", "Jack Thompson", "standard", "Y", 2, [nxTo("LAX")], {}),
  pnr("NYL9WD", "Aya Al-Rashid", "standard", "Y", 1, [nxTo("PEK")], {}),
  pnr("NYM5XH", "Bongani Dlamini", "silver", "B", 2, [nxTo("PVG")], {}),
  pnr("NYN7CQ", "Elena Marin", "standard", "Y", 1, [nxTo("MNL")], {}),
  pnr("NYP3JL", "Omar Farouk", "gold", "Y", 2, [nxTo("CGK")], {}),
  pnr("NYQ6VA", "Siti Nurhaliza", "standard", "Y", 4, [nxTo("KUL")], {
    ssr: ["MEAL_KSML"],
  }),
];

writeFileSync(
  new URL("../../apps/rebook-ai/seed/reference-day.json", import.meta.url),
  JSON.stringify({ referenceDay: DAY, timezone: "Asia/Singapore", flights: schedule }, null, 2) +
    "\n",
);
writeFileSync(
  new URL("../../apps/rebook-ai/seed/inventory.json", import.meta.url),
  JSON.stringify({ referenceDay: DAY, candidates: inventory }, null, 2) + "\n",
);
writeFileSync(
  new URL("../../apps/rebook-ai/seed/pnrs.json", import.meta.url),
  JSON.stringify({ referenceDay: DAY, pnrs }, null, 2) + "\n",
);
console.info(`schedule=${schedule.length} inventory=${inventory.length} pnrs=${pnrs.length}`);
