/**
 * Deterministic NX-320 corpus generator (PRD F-1/F-2, data-model.md §4).
 *
 * The committed Markdown under seed/manuals/ is the source of truth for
 * ingestion; this script is the authoring tool that produced it. It is
 * deterministic (seeded PRNG, no clocks): two runs emit byte-identical files,
 * so reviewers diff manuals in git and the ingest idempotency invariant
 * (FR-5) holds across regenerations.
 *
 * All content is fictional (data-ethics.md §2): aircraft type NX-320,
 * "NX-"-prefixed part numbers, invented task/figure/bullet identifiers and
 * fault codes. Every task card carries a visible simulated-corpus note.
 *
 * Run: pnpm --filter mro-copilot corpus:generate
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const SEED = 0x320320;
const OUT_DIR = path.resolve(import.meta.dirname, "..");
const MANUALS_DIR = path.join(OUT_DIR, "manuals");

/** Deterministic PRNG (mulberry32) — same seed, same corpus. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Attach caution/warning notes to selected steps. Per data-model.md §5 a
 * warning is never split from its parent step block — the ingest chunker
 * treats an indented NOTE/CAUTION/WARNING line as part of the step's block.
 */
function withWarnings(
  steps: string[],
  rand: Rand,
  bank: ChapterBank,
  seedOffset: number,
): string[] {
  const noteRand = makeRand(SEED + seedOffset);
  const kinds = ["WARNING", "CAUTION", "NOTE"] as const;
  return steps.map((step, i) => {
    const roll = noteRand.next();
    if (roll < 0.3) {
      const kind = kinds[Math.floor(roll * kinds.length * 4.5)] ?? "NOTE";
      const hazard = i % 2 === 0 ? noteRand.pick(bank.hazards) : null;
      const note =
        hazard ??
        `Verify the ${noteRand.pick(bank.components)} is relieved of ${noteRand.pick(["pressure", "power", "residual torque", "stored energy"])} before continuing.`;
      return `${step}\n   ${kind}: ${note}`;
    }
    return step;
  });
}

interface Rand {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  some<T>(items: readonly T[], count: number): T[];
}

function makeRand(seed: number): Rand {
  const next = rng(seed);
  return {
    next,
    int(minInclusive, maxInclusive) {
      return minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));
    },
    pick(items) {
      return items[Math.floor(next() * items.length)] as never;
    },
    some<T2>(items: readonly T2[], count: number): T2[] {
      const pool = [...items];
      const out: T2[] = [];
      while (out.length < count && pool.length > 0) {
        out.push(pool.splice(Math.floor(next() * pool.length), 1)[0] as T2);
      }
      return out;
    },
  };
}

/** --------------------------------------------------------------------- *
 * Domain phrase banks (hand-authored; fictional NX-320 systems).
 * --------------------------------------------------------------------- */

interface ChapterBank {
  chapter: string;
  name: string;
  system: string;
  components: string[];
  assemblies: string[];
  hazards: string[];
  checks: string[];
  quantities: string[];
}

const CHAPTERS: ChapterBank[] = [
  {
    chapter: "21",
    name: "Air Conditioning",
    system: "air conditioning and pressurization",
    components: [
      "pack flow control valve",
      "cooling turbine unit",
      "water extractor",
      "cabin pressure outflow valve",
      "temperature trim air valve",
      "re-circulation fan",
    ],
    assemblies: ["conditioned air distribution manifold", "pack bay ducting assembly"],
    hazards: [
      "pack bay reaches flight-idle temperatures within seconds of pack start",
      "conditioned air ducts can exceed 120 °C during bleed operations",
      "sudden cabin pressure changes can dislodge unsecured panels",
    ],
    checks: [
      "pack flow indication stabilizes within the commanded band",
      "outflow valve travels smoothly through its full range",
      "no whistling is audible at the distribution manifold joints",
    ],
    quantities: ["pack outlet temperature 8.2 °C", "trim air pressure 34 psi", "cabin Δp 7.8 psi"],
  },
  {
    chapter: "24",
    name: "Electrical Power",
    system: "electrical power generation and distribution",
    components: [
      "variable speed constant frequency generator",
      "generator control unit",
      "transformer rectifier unit",
      "static inverter",
      "main battery contactor",
      "electrical essential bus feed breaker",
    ],
    assemblies: ["primary power distribution rack", "battery relay panel"],
    hazards: [
      "the TRU cooling fins stay hot for several minutes after shutdown",
      "battery terminals are live even with the battery switch OFF",
      "arc-flash PPE is mandatory before opening loaded bus tie panels",
    ],
    checks: [
      "generator frequency holds 400 Hz ± 2 Hz under load transfer",
      "TRU output ripple stays below the stated limit for 60 s",
      "battery contactor clicks once, without chattering, on engage",
    ],
    quantities: ["TRU output 28.0 VDC", "generator load 38 kVA", "battery voltage 24.6 VDC"],
  },
  {
    chapter: "27",
    name: "Flight Controls",
    system: "primary and secondary flight controls",
    components: [
      "aileron PCU",
      "elevator feel and centering unit",
      "rudder trim actuator",
      "flap skew sensor",
      "spoiler mixer unit",
      "pitch trim motor clutch",
    ],
    assemblies: ["aileron cable drum assembly", "flap carriage and track assembly"],
    hazards: [
      "hydraulic pressure in the PCU circuit can cause uncommanded surface movement",
      "flap surfaces can drift under their own weight when the tracks are released",
      "control surface mass balance weights must never be loosened without support",
    ],
    checks: [
      "surface travels match the rigging pin reference within 0.5°",
      "no fretting is visible on the carriage rollers",
      "the feel force gradient stays within the tolerance band",
    ],
    quantities: [
      "aileron deflection 22.4°",
      "feel force gradient 4.1 daN",
      "flap skew margin 1.8°",
    ],
  },
  {
    chapter: "28",
    name: "Fuel",
    system: "fuel storage and distribution",
    components: [
      "center tank fuel pump",
      "fuel quantity indication computer",
      "refuel/defuel selector valve",
      "fuel transfer jet pump",
      "wing tank water scavenger system",
      "low-pressure fuel shut-off valve",
    ],
    assemblies: ["fuel pump inlet strainer housing", "refuel gallery coupling assembly"],
    hazards: [
      "fuel vapour in the tank volume is explosive at ordinary temperatures",
      "bonding leads must connect before any fuel line is broken",
      "residual fuel keeps dripping from couplings for several minutes",
    ],
    checks: [
      "indicating system reads the known test volume within ±0.4 %",
      "no external leakage appears at the gallery coupling after 10 min",
      "the scavenger pump cycles once and stops within the stated time",
    ],
    quantities: [
      "tank differential pressure 12 psi",
      "scavenger cycle time 95 s",
      "indicating tolerance 0.35 %",
    ],
  },
  {
    chapter: "29",
    name: "Hydraulic Power",
    system: "hydraulic power generation and distribution",
    components: [
      "hydraulic reservoir pressurization module",
      "engine-driven pump (EDP)",
      "electric motor pump (EMP)",
      "power transfer unit",
      "hydraulic accumulator",
      "case drain filter module",
    ],
    assemblies: ["hydraulic reservoir attach bracket set", "EDP drive shaft coupling"],
    hazards: [
      "residual pressure in the high-pressure manifold can inject fluid through the skin",
      "Skydrol rapidly degrades eye tissue — goggles are mandatory",
      "the accumulator pre-charge side stays pressurized with the system depressurized",
    ],
    checks: [
      "system pressure holds 3000 psi with pumps unloaded for 5 min",
      "no external leakage appears at the module ports after pressurization",
      "accumulator gas pre-charge reads within tolerance on the gauge rig",
    ],
    quantities: [
      "accumulator air pre-charge 1450 psi",
      "case drain flow 0.8 l/min",
      "unloaded system decay 120 psi/min",
    ],
  },
  {
    chapter: "32",
    name: "Landing Gear",
    system: "landing gear and steering",
    components: [
      "nose landing gear shock absorber",
      "main gear side stay pin",
      "landing gear uplock assembly",
      "nose wheel steering tiller feedback unit",
      "gear actuating cylinder snubber",
      "tire pressure sensor unit",
    ],
    assemblies: ["side stay pin attach hardware kit", "uplock roller and spring kit"],
    hazards: [
      "gear doors can fall when their hinges are disconnected without support",
      "the shock absorber is charged to high pressure even with the aircraft on jacks",
      "an unsecured uplock can release the gear under its own weight",
    ],
    checks: [
      "retraction and extension times stay within the acceptance band",
      "uplock rollers show no flat spots under the borescope",
      "steering tiller feedback tracks wheel angle within 1°",
    ],
    quantities: [
      "strut pressure 615 psi at 21 °C",
      "extension time 11.5 s",
      "steering tracking error 0.8°",
    ],
  },
  {
    chapter: "34",
    name: "Navigation",
    system: "navigation and air data",
    components: [
      "air data inertial reference unit",
      "angle-of-attack sensor vane",
      "radio altimeter transceiver",
      "magnetic variometer compensation module",
      "pitot probe heat controller",
      "standby attitude module",
    ],
    assemblies: ["ADR pitot line disconnect panel", "AOA vane mounting mast"],
    hazards: [
      "probe heat reaches burn temperatures within seconds when powered",
      "the standby battery keeps the attitude module live with all power off",
      "AOA vanes are mass-balanced — never rotate one backwards by hand",
    ],
    checks: [
      "air data outputs match the test set within the stated tolerance",
      "vane friction stays below the torque-band limit over full travel",
      "radio altimeter height reads the bench reference at 30 ft",
    ],
    quantities: ["vane friction torque 0.9 Nm", "radio alt error 1.4 ft", "pitot heat 241 W"],
  },
  {
    chapter: "36",
    name: "Pneumatic",
    system: "bleed air and pneumatic distribution",
    components: [
      "bleed pre-cooler control valve",
      "pressure regulating valve",
      "duct leak detection loop",
      "APU load compressor inlet valve",
      "cross-bleed valve actuator",
      "overpressure shut-off switch",
    ],
    assemblies: ["pre-cooler core housing assembly", "bleed duct clamp collar set"],
    hazards: [
      "bleed ducts carry 200 °C air at pressure — burns and injection injuries are likely",
      "the overpressure switch resets only below 15 psi line pressure",
      "duct clamp collars hold stored spring energy when loosened unevenly",
    ],
    checks: [
      "regulated pressure holds the set value across the flow range",
      "leak detection loop resistance stays inside the pass band",
      "the pre-cooler outlet stays below the stated ceiling at max flow",
    ],
    quantities: [
      "regulated bleed pressure 42 psi",
      "pre-cooler outlet 178 °C",
      "loop resistance 4.2 Ω",
    ],
  },
  {
    chapter: "26",
    name: "Fire Protection",
    system: "fire detection and extinguishing",
    components: [
      "engine fire detection loop element",
      "cargo compartment smoke detector",
      "fire extinguisher bottle squib",
      "APU fire extinguishing bottle",
      "lavatory smoke detector unit",
      "fire handle unlock solenoid",
    ],
    assemblies: ["cargo smoke detection manifold", "extinguisher bottle mounting strap set"],
    hazards: [
      "extinguisher bottles are pressurized — a discharged squib can cause injury",
      "the detection loop stays armed with the engine OFF",
      "test filaments stay hot enough to burn skin for a minute after the test",
    ],
    checks: [
      "the detection loop resistance stays inside the pass band",
      "the bottle pressure gauge reads within the green band",
      "the smoke detector alarms on the reference test smoke pattern",
    ],
    quantities: ["bottle pressure 1250 psi", "loop resistance 3.8 Ω", "alarm response 12 s"],
  },
  {
    chapter: "49",
    name: "Auxiliary Power Unit",
    system: "auxiliary power unit",
    components: [
      "APU start contactor",
      "APU fuel metering valve",
      "load compressor surge control valve",
      "APU oil pressure transmitter",
      "EBU bleed air shut-off valve",
      "APU intake door actuator",
    ],
    assemblies: ["APU fuel metering valve coupling kit", "intake door hinge bearing set"],
    hazards: [
      "the APU compartment stays hot enough to ignite residual fuel vapour for 15 min after shutdown",
      "the intake door can close under gravity when its actuator is disconnected",
      "APU starter torque can injure hands left near the ring gear",
    ],
    checks: [
      "EGT stays inside the start curve during a dry motoring check",
      "oil pressure reaches the idle floor within the stated seconds",
      "the intake door reaches full open within its acceptance time",
    ],
    quantities: [
      "idle oil pressure 58 psi",
      "intake door open time 6.5 s",
      "start peak EGT 512 °C",
    ],
  },
];

const AMM_TASK_TITLES = [
  "removal and installation",
  "inspection and check",
  "operational test",
  "adjustment and rigging",
  "replacement",
];

const TOOL_NAMES = [
  "NXT-210 torque wrench set",
  "NXT-314 rigging pin kit",
  "NXT-422 hydraulic test rig",
  "NXT-508 bonding meter",
  "NXT-630 borescope",
  "NXT-777 system test set",
  "NXT-845 pressure gauge rig",
  "NXT-911 generator load bank",
];

const SUPPLIERS = [
  "Nordwind Aero Supply",
  "Kepler Avionics",
  "Halcyon Hydraulics",
  "Meridian Gear Co.",
];

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** --------------------------------------------------------------------- *
 * Document models + renderers
 * --------------------------------------------------------------------- */

interface AmmTask {
  kind: "AMM";
  chapter: string;
  group: string;
  taskNo: string;
  title: string;
  revision: string;
  effectiveDate: string;
  fileName: string;
  general: string[];
  tools: { name: string; note: string }[];
  removalSteps: string[];
  installationSteps: string[];
  testSteps: string[];
  checks: string[];
  hazards: string[];
  facts: string[];
}

function ammTasks(rand: Rand): AmmTask[] {
  const tasks: AmmTask[] = [];
  for (const bank of CHAPTERS) {
    const perChapter = bank.chapter === "29" ? 5 : 4;
    for (let i = 1; i <= perChapter; i++) {
      const group = `${bank.chapter}-${pad(rand.int(10, 49), 2)}-00`;
      const taskNo = `${group}-${pad(rand.int(100, 480), 3)}-${pad(rand.int(101, 409), 3)}`;
      const component = rand.pick(bank.components);
      const kind = rand.pick(AMM_TASK_TITLES);
      const title = `${component} — ${kind}`;
      const torque = rand.int(12, 96) + rand.pick([0.5, 0, 0.5]);
      const torqueUnit = rand.pick(["Nm", "Nm", "lbf·ft"]);
      const torqueText =
        torqueUnit === "Nm" ? `${torque.toFixed(1)} Nm` : `${(torque * 0.74).toFixed(1)} lbf·ft`;
      const pressure = rand.int(28, 3000);
      const partBase = `NX-${bank.chapter}${pad(rand.int(10, 99), 2)}`;
      const pn = `${partBase}-${rand.int(100, 999)}-${rand.pick(["A", "B", "C"])}`;
      const removal: string[] = [];
      const install: string[] = [];
      const test: string[] = [];
      removal.push(
        `Depressurize and drain the ${bank.system} circuit serving the ${component}, then verify zero pressure on the associated gauge.`,
        `Attach the applicable warning placards and open the access panel adjacent to the ${component}.`,
        `Disconnect the electrical connector of the ${component} and cap the receptacle with a protective cover.`,
        `Support the ${component} with a suitable sling before loosening any attach hardware.`,
        `Remove the attach bolts of the ${component} and retain all washers and shims for re-installation reference.`,
        `Withdraw the ${component} from its mounts, keeping the mating faces free of scratches, and route it to the bench.`,
      );
      install.push(
        `Position the ${component} on its mounts and hand-start all attach bolts before applying torque.`,
        `Torque the ${component} attach bolts to ${torqueText} in the crosswise sequence shown on the torque plate.`,
        `Reconnect the electrical connector of the ${component} and confirm the latch clicks fully home.`,
        `Restore the ${bank.system} circuit supply to the ${component} and bleed the applicable lines as specified.`,
        `Apply gentle pressure and confirm the seal of the ${component} mating faces; replace the seal if extrusion is visible (seal kit ${pn}).`,
        `Close the access panel and remove the warning placards once the ${component} is secured.`,
      );
      test.push(
        `Energize the ${bank.system} test configuration and confirm the ${component} responds to command inputs.`,
        `Record the reference value ${rand.pick(bank.quantities)} and compare it with the acceptance band for the ${component}.`,
        `Cycle the ${component} through ${rand.int(3, 6)} complete operating cycles and watch for hesitation or drift.`,
        `Leak-check every port and coupling touched during this task with the system at operating pressure.`,
      );
      for (let s = 1; s <= 38; s++) {
        removal.push(
          `Tag and disconnect the ${rand.pick(["hydraulic line", "vent line", "drain line", "bonding lead", "bracket", "sensor line", "clamp collar", "support strut"])} at position ${pad(s, 2)} of the ${component} installation; plug all open ports immediately.`,
        );
      }
      for (let s = 1; s <= 42; s++) {
        install.push(
          `Reinstall the ${rand.pick(["hydraulic line", "vent line", "drain line", "bonding lead", "bracket", "sensor line", "clamp collar", "support strut"])} at position ${pad(s, 2)} of the ${component} installation; torque the coupling per the standard practice table.`,
        );
      }
      for (let s = 1; s <= 18; s++) {
        test.push(
          `Monitor the ${rand.pick(bank.checks)} during cycle ${pad(s, 2)} and log any deviation in the task sheet.`,
        );
      }
      const checks = rand.some(bank.checks, 3).map((c) => `Confirm that ${c}.`);
      const hazards = [...rand.some(bank.hazards, 2)];
      const facts = [
        `Torque the ${component} attach bolts to ${torqueText}.`,
        `Reference part number for the ${component} seal kit: ${pn} (${rand.pick(SUPPLIERS)}).`,
        `Acceptance reference: ${rand.pick(bank.quantities)}.`,
      ];
      tasks.push({
        kind: "AMM",
        chapter: bank.chapter,
        group,
        taskNo,
        title,
        revision: `Rev ${rand.int(21, 44)}`,
        effectiveDate: `202${rand.int(4, 6)}-${pad(rand.int(1, 12), 2)}-${pad(rand.int(1, 28), 2)}`,
        fileName: "",
        general: [
          `This task card covers the ${kind} of the ${component} on the NX-320 ${bank.system} (${bank.name}, ATA ${bank.chapter}).`,
          `The ${component} is installed in the ${rand.pick(bank.assemblies)} and shares mounting hardware with adjacent systems.`,
          `Bench-test operating pressure reference for this card: ${pressure} bar.`,
          `This card belongs to the simulated NX-320 training corpus (fictional aircraft; not for real-world maintenance use).`,
        ],
        tools: [
          { name: rand.pick(TOOL_NAMES), note: "calibrated within the last 12 months" },
          { name: rand.pick(TOOL_NAMES), note: "with the applicable adapter set" },
          { name: `Seal kit ${pn}`, note: `${rand.pick(SUPPLIERS)}` },
        ],
        removalSteps: withWarnings(removal, rand, bank, i * 7 + 1),
        installationSteps: withWarnings(install, rand, bank, i * 7 + 2),
        testSteps: withWarnings(test, rand, bank, i * 7 + 3),
        checks,
        hazards,
        facts,
      });
    }
  }
  return tasks;
}

function frontMatter(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---`;
}

function pageMarker(page: number): string {
  return `<!-- page: ${page} -->`;
}

function renderAmm(task: AmmTask): string {
  const breadcrumb = `NX320 AMM · ATA ${task.chapter} · ${task.group} · Task ${task.taskNo} · ${task.title}`;
  const head = [
    frontMatter({
      doc_type: "AMM",
      title: task.title,
      ata_chapter: task.chapter,
      task_no: task.taskNo,
      revision: task.revision,
      effective_date: task.effectiveDate,
    }),
    "",
    `# ${breadcrumb}`,
    "",
  ].join("\n");
  const body: string[] = [];
  body.push("## General", "");
  body.push(...task.general, "");
  body.push("## Safety", "");
  body.push(`The following hazards apply while working on the ${task.title.split(" — ")[0]}:`, "");
  body.push(...task.hazards.map((h) => `- ${h}`), "");
  body.push("## Tools and Equipment", "");
  for (const t of task.tools) {
    body.push(`- ${t.name} — ${t.note}.`);
  }
  body.push("", "## Procedure", "", "### Removal", "");
  body.push(...task.removalSteps.map((s, i) => `${i + 1}. ${s}`), "");
  body.push("### Installation", "");
  body.push(...task.installationSteps.map((s, i) => `${i + 1}. ${s}`), "");
  body.push("### Test and Close-up", "");
  body.push(...task.testSteps.map((s, i) => `${i + 1}. ${s}`), "");
  return head + injectPages(body.join("\n"), pageBase(task.taskNo));
}

/** Insert deterministic fictional page markers roughly every ~1400 characters. */
function injectPages(body: string, pageBase: number): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let page = pageBase;
  let since = 0;
  let first = true;
  for (const line of lines) {
    out.push(line);
    since += line.length + 1;
    if (!first && since > 1400 && !line.startsWith("#") && !line.startsWith("|")) {
      page += 1;
      out.push("", pageMarker(page));
      since = 0;
    }
    first = false;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Deterministic fictional page base per document id (citations render it). */
function pageBase(id: string): number {
  let h = 7;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return 80 + (Math.abs(h) % 320);
}

interface TsmTask {
  kind: "TSM";
  chapter: string;
  taskNo: string;
  faultCode: string;
  title: string;
  revision: string;
  effectiveDate: string;
  fileName: string;
  symptom: string;
  causes: string[];
  isolation: string[];
  facts: string[];
}

function tsmTasks(rand: Rand): TsmTask[] {
  const out: TsmTask[] = [];
  const picks = rand.some(CHAPTERS, 10);
  const symptoms = [
    "intermittent indication",
    "fails to respond to command",
    "out-of-range reading on the related display",
    "audible noise during operation",
    "slow response after start",
    "vibration reported by the crew",
    "warning message after power-up",
    "no output at the related sensor",
  ];
  picks.forEach((bank, idx) => {
    const component = rand.pick(bank.components);
    const symptom = symptoms[idx % symptoms.length] ?? "indication fault";
    const faultCode = `FC-${bank.chapter}${pad(rand.int(10, 99), 2)}-${pad(rand.int(100, 999), 3)}`;
    const taskNo = `${bank.chapter}-${pad(rand.int(10, 49), 2)}-00-${pad(rand.int(200, 490), 3)}-${pad(rand.int(210, 418), 3)}`;
    const causes = rand
      .some(bank.components, 3)
      .map((c) => `Faulty or contaminated ${c} in the ${bank.system} circuit.`);
    causes.push(`Open or chafed wiring between the ${component} and its control unit.`);
    const isolation: string[] = [];
    isolation.push(
      `Connect the ${rand.pick(TOOL_NAMES)} and read the current fault code; confirm ${faultCode} is active.`,
      `Bite the ${bank.system} circuit: check that the reported symptom "${symptom}" is reproducible on demand.`,
    );
    for (let s = 1; s <= 38; s++) {
      isolation.push(
        `Isolation step ${pad(s, 2)}: measure the ${rand.pick(["resistance", "supply voltage", "pressure", "flow", "signal amplitude"])} at test point TP-${pad(rand.int(1, 40), 2)} and compare with the ${bank.name} tolerance table; record the value.`,
      );
    }
    isolation.push(
      `If all preceding measurements pass, replace the ${component} and repeat the operational check before closing the task.`,
    );
    out.push({
      kind: "TSM",
      chapter: bank.chapter,
      taskNo,
      faultCode,
      title: `${component} — fault isolation (${symptom})`,
      revision: `Rev ${rand.int(15, 40)}`,
      effectiveDate: `202${rand.int(4, 6)}-${pad(rand.int(1, 12), 2)}-${pad(rand.int(1, 28), 2)}`,
      fileName: "",
      symptom,
      causes,
      isolation,
      facts: [
        `Fault code ${faultCode} maps to the ${component} (${symptom}).`,
        `First isolation action: connect the test set and confirm fault code ${faultCode}.`,
        `Primary suspect when measurements pass: replace the ${component}.`,
      ],
    });
  });
  return out;
}

function renderTsm(task: TsmTask): string {
  const breadcrumb = `NX320 TSM · ATA ${task.chapter} · Task ${task.taskNo} · ${task.title}`;
  const head = [
    frontMatter({
      doc_type: "TSM",
      title: task.title,
      ata_chapter: task.chapter,
      task_no: task.taskNo,
      revision: task.revision,
      effective_date: task.effectiveDate,
    }),
    "",
    `# ${breadcrumb}`,
    "",
  ].join("\n");
  const body: string[] = [];
  body.push("## Fault Code and Symptom", "");
  body.push(
    `Fault code ${task.faultCode} is reported for the ${task.title.split(" — ")[0]}. Observed symptom: ${task.symptom}.`,
    "",
    "This card belongs to the simulated NX-320 training corpus (fictional aircraft; not for real-world maintenance use).",
    "",
  );
  body.push("## Probable Causes", "");
  body.push(...task.causes.map((c, i) => `${i + 1}. ${c}`), "");
  body.push("## Isolation Procedure", "");
  body.push(...task.isolation.map((s, i) => `${i + 1}. ${s}`), "");
  body.push("## Rectification Check", "");
  body.push(
    `Clear ${task.faultCode}, then operate the affected system through ${rand3(task.taskNo)} cycles and verify the symptom does not return.`,
    "",
  );
  return head + injectPages(body.join("\n"), pageBase(task.taskNo));
}

function rand3(seedText: string): number {
  let h = 0;
  for (const ch of seedText) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return 3 + (Math.abs(h) % 4);
}

interface IpcDoc {
  kind: "IPC";
  chapter: string;
  figureId: string;
  title: string;
  revision: string;
  effectiveDate: string;
  fileName: string;
  figures: { figNo: string; name: string; rows: string[] }[];
  facts: string[];
}

function ipcDocs(rand: Rand): IpcDoc[] {
  const assemblies: [ChapterBank, string][] = [
    [CHAPTERS[4]!, "hydraulic reservoir assembly"],
    [CHAPTERS[5]!, "nose landing gear assembly"],
    [CHAPTERS[2]!, "aileron actuator assembly"],
    [CHAPTERS[6]!, "bleed pre-cooler assembly"],
    [CHAPTERS[1]!, "transformer rectifier unit assembly"],
  ];
  return assemblies.map(([bank, assembly]) => {
    const figureId = `${bank.chapter}-${pad(rand.int(11, 55), 2)}-${pad(rand.int(1, 9), 2)}`;
    const figures = [1, 2, 3].map((f) => {
      const rows: string[] = [];
      const rowCount = rand.int(24, 40);
      for (let r = 1; r <= rowCount; r++) {
        const pn = `NX-${bank.chapter}${pad(rand.int(10, 99), 2)}-${rand.int(100, 999)}-${rand.pick(["A", "B", "C", "D"])}`;
        const item =
          r === 1
            ? rand.pick(bank.components)
            : rand.pick([
                ...bank.components,
                "o-ring seal",
                "attach bolt",
                "lock washer",
                "clamp collar",
                "gasket",
                "retainer ring",
                "coupling half",
              ]);
        rows.push(
          `| ${pad(r, 2)} | ${pn} | ${item} | ${rand.int(1, 8)} | ${rand.pick(SUPPLIERS)} |`,
        );
      }
      return { figNo: `${figureId}-F${f}`, name: `${assembly} — figure ${f}`, rows };
    });
    return {
      kind: "IPC",
      chapter: bank.chapter,
      figureId,
      title: `${assembly} — parts list`,
      revision: `Rev ${rand.int(18, 42)}`,
      effectiveDate: `202${rand.int(4, 6)}-${pad(rand.int(1, 12), 2)}-${pad(rand.int(1, 28), 2)}`,
      fileName: "",
      figures,
      facts: [
        `Figure ${figures[0]!.figNo} item 01 lists the primary component: ${figures[0]!.rows[0]?.split("|")[3]?.trim()}.`,
      ],
    };
  });
}

function renderIpc(doc: IpcDoc): string {
  const breadcrumb = `NX320 IPC · ATA ${doc.chapter} · Figure ${doc.figureId} · ${doc.title}`;
  const head = [
    frontMatter({
      doc_type: "IPC",
      title: doc.title,
      ata_chapter: doc.chapter,
      task_no: doc.figureId,
      revision: doc.revision,
      effective_date: doc.effectiveDate,
    }),
    "",
    `# ${breadcrumb}`,
    "",
  ].join("\n");
  const body: string[] = [];
  body.push("## Assembly Overview", "");
  body.push(
    `Illustrated parts data for the ${doc.title.replace(" — parts list", "")} on the NX-320 (simulated corpus; fictional part numbers).`,
    "",
  );
  for (const fig of doc.figures) {
    body.push(`### Figure ${fig.figNo} · ${fig.name}`, "");
    body.push("| Item | Part number | Nomenclature | Qty | Supplier |", "|---|---|---|---|---|");
    body.push(...fig.rows, "");
  }
  return head + injectPages(body.join("\n"), pageBase(doc.figureId));
}

interface SbDoc {
  kind: "SB";
  chapter: string;
  sbNo: string;
  revision: string;
  title: string;
  effectiveDate: string;
  fileName: string;
  description: string[];
  applicability: string;
  accomplishment: string[];
  facts: string[];
}

function sbDocs(rand: Rand): SbDoc[] {
  const banks = [CHAPTERS[4]!, CHAPTERS[5]!, CHAPTERS[6]!, CHAPTERS[7]!, CHAPTERS[1]!];
  const titles = [
    "reservoir pressurization module fleet improvement",
    "side stay pin inspection interval extension",
    "AOA vane connector seal replacement",
    "bleed duct clamp collar re-torque campaign",
    "TRU cooling fin corrosion protection",
  ];
  return banks.map((bank, i) => {
    // The first bullet is numbered SB-29-002 so its Rev 02 (renderSbRev02)
    // forms the committed supersession pair under the same task_no.
    const sbNo = i === 0 ? "SB-29-002" : `SB-${bank.chapter}-${pad(i + 1, 3)}`;
    const component = rand.pick(bank.components);
    const fromLn = rand.int(12, 40);
    const toLn = fromLn + rand.int(30, 90);
    const mod = `modified ${component} retained by the new clamp configuration`;
    const accomplishment = [
      `Accomplish the modification during the next scheduled ${bank.name.toLowerCase()} check, or within ${rand.int(400, 2500)} flight hours, whichever comes first.`,
      `Install the modification kit NX-SB${bank.chapter}-${pad(i + 1, 3)}-K per the included instruction sheet.`,
      `Torque the new attach hardware to ${rand.int(20, 80)},${rand.int(0, 9)} Nm and apply torque seal.`,
      `Update the aircraft records to reflect the ${mod}.`,
    ];
    for (let s = 1; s <= 10; s++) {
      accomplishment.push(
        `Campaign step ${pad(s, 2)}: verify the ${rand.pick(bank.checks)} and record the as-found condition on the SB worksheet.`,
      );
    }
    return {
      kind: "SB",
      chapter: bank.chapter,
      sbNo,
      revision: "Rev 01",
      title: `${component} — ${titles[i]}`,
      effectiveDate: `2025-${pad(rand.int(1, 12), 2)}-${pad(rand.int(1, 28), 2)}`,
      fileName: "",
      description: [
        `This service bulletin introduces the ${mod} for the NX-320 ${bank.system}.`,
        `The change prevents the recurrence of the field-reported condition documented under the ${bank.name} reliability program.`,
        "This bulletin belongs to the simulated NX-320 training corpus (fictional aircraft; not for real-world use).",
      ],
      applicability: `Applicable to NX-320 aircraft line numbers ${fromLn} through ${toLn} not incorporating modification status MOD-${bank.chapter}${pad(rand.int(100, 999), 3)}.`,
      accomplishment,
      facts: [
        `${sbNo} applies to NX-320 line numbers ${fromLn}–${toLn}.`,
        `${sbNo} accomplishment interval: within ${rand.int(400, 2500)} flight hours of the effective date.`,
      ],
    };
  });
}

function renderSb(doc: SbDoc): string {
  const breadcrumb = `NX320 SB · ${doc.sbNo} · ${doc.revision} · ${doc.title}`;
  const head = [
    frontMatter({
      doc_type: "SB",
      title: doc.title,
      ata_chapter: doc.chapter,
      task_no: doc.sbNo,
      revision: doc.revision,
      effective_date: doc.effectiveDate,
    }),
    "",
    `# ${breadcrumb}`,
    "",
  ].join("\n");
  const body: string[] = [];
  body.push("## Description", "");
  body.push(...doc.description, "");
  body.push("## Applicability", "");
  body.push(doc.applicability, "");
  body.push("## Accomplishment Instructions", "");
  body.push(...doc.accomplishment.map((s, i) => `${i + 1}. ${s}`), "");
  return head + injectPages(body.join("\n"), pageBase(doc.sbNo + doc.revision));
}

/** Rev 02 supersedes Rev 01 — exercises the supersession path end-to-end. */
function renderSbRev02(base: SbDoc): string {
  const rand = makeRand(SEED + 77);
  const rev02: SbDoc = {
    ...base,
    revision: "Rev 02",
    effectiveDate: "2026-02-14",
    description: [
      ...base.description.slice(0, 2),
      "Rev 02 extends the accomplishment interval and adds the post-modification operational check introduced with fleet feedback.",
      "This bulletin belongs to the simulated NX-320 training corpus (fictional aircraft; not for real-world use).",
    ],
    accomplishment: [
      ...base.accomplishment,
      "Rev 02 addition: after step 1, perform the post-modification operational check and record the result before closing the campaign worksheet.",
      `Rev 02 addition: confirm the modified component retained by the new clamp configuration passes ${rand.pick(base.description).includes("clamp") ? "the clamp fit check" : "the standard acceptance test"}.`,
    ],
  };
  rev02.facts = [
    ...base.facts,
    `${base.sbNo} Rev 02 supersedes Rev 01 and extends the accomplishment interval.`,
  ];
  return renderSb(rev02);
}

/** --------------------------------------------------------------------- *
 * Emit files + manifest
 * --------------------------------------------------------------------- */

interface ManifestEntry {
  docType: "AMM" | "IPC" | "TSM" | "SB";
  title: string;
  ataChapter: string;
  taskNo: string;
  revision: string;
  effectiveDate: string;
  sourcePath: string;
  facts: string[];
}

function main(): void {
  const rand = makeRand(SEED);
  const entries: ManifestEntry[] = [];

  // The generator owns the corpus directory: stale files from earlier runs
  // would silently grow the corpus and corrupt ingest determinism.
  rmSync(MANUALS_DIR, { recursive: true, force: true });
  mkdirSync(MANUALS_DIR, { recursive: true });
  for (const dir of ["amm", "ipc", "tsm", "sb"]) {
    mkdirSync(path.join(MANUALS_DIR, dir), { recursive: true });
  }

  const amms = ammTasks(rand);
  amms.forEach((t, i) => {
    t.fileName = `amm/${t.chapter}-${pad(i + 1, 2)}-${t.taskNo}.md`;
  });
  const tsms = tsmTasks(rand);
  tsms.forEach((t, i) => {
    t.fileName = `tsm/${t.chapter}-${pad(i + 1, 2)}-${t.faultCode}.md`;
  });
  const ipcs = ipcDocs(rand);
  ipcs.forEach((d, i) => {
    d.fileName = `ipc/${d.chapter}-${pad(i + 1, 2)}-${d.figureId}.md`;
  });
  const sbs = sbDocs(rand);
  sbs.forEach((d) => {
    d.fileName = `sb/${d.sbNo}-rev01.md`;
  });

  const writes: { relPath: string; body: string; entry: ManifestEntry }[] = [];
  amms.forEach((t) => {
    writes.push({
      relPath: t.fileName,
      body: renderAmm(t),
      entry: {
        docType: "AMM",
        title: t.title,
        ataChapter: t.chapter,
        taskNo: t.taskNo,
        revision: t.revision,
        effectiveDate: t.effectiveDate,
        sourcePath: `manuals/${t.fileName}`,
        facts: t.facts,
      },
    });
  });
  tsms.forEach((t) => {
    writes.push({
      relPath: t.fileName,
      body: renderTsm(t),
      entry: {
        docType: "TSM",
        title: t.title,
        ataChapter: t.chapter,
        taskNo: t.taskNo,
        revision: t.revision,
        effectiveDate: t.effectiveDate,
        sourcePath: `manuals/${t.fileName}`,
        facts: t.facts,
      },
    });
  });
  ipcs.forEach((d) => {
    writes.push({
      relPath: d.fileName,
      body: renderIpc(d),
      entry: {
        docType: "IPC",
        title: d.title,
        ataChapter: d.chapter,
        taskNo: d.figureId,
        revision: d.revision,
        effectiveDate: d.effectiveDate,
        sourcePath: `manuals/${d.fileName}`,
        facts: d.facts,
      },
    });
  });
  sbs.forEach((d) => {
    writes.push({
      relPath: d.fileName,
      body: renderSb(d),
      entry: {
        docType: "SB",
        title: d.title,
        ataChapter: d.chapter,
        taskNo: d.sbNo,
        revision: d.revision,
        effectiveDate: d.effectiveDate,
        sourcePath: `manuals/${d.fileName}`,
        facts: d.facts,
      },
    });
  });
  // Supersession pair: SB-29-002 Rev 02 file alongside Rev 01.
  const sb29base = sbs.find((d) => d.sbNo === "SB-29-002");
  if (sb29base) {
    writes.push({
      relPath: "sb/SB-29-002-rev02.md",
      body: renderSbRev02(sb29base),
      entry: {
        docType: "SB",
        title: sb29base.title,
        ataChapter: sb29base.chapter,
        taskNo: sb29base.sbNo,
        revision: "Rev 02",
        effectiveDate: "2026-02-14",
        sourcePath: "manuals/sb/SB-29-002-rev02.md",
        facts: [`${sb29base.sbNo} Rev 02 supersedes Rev 01 (effective 2026-02-14).`],
      },
    });
  }

  for (const w of writes) {
    writeFileSync(path.join(MANUALS_DIR, w.relPath), w.body, "utf8");
    entries.push(w.entry);
  }

  const manifest = {
    version: 1,
    description:
      "Deterministic manifest of the fictional NX-320 corpus (data-model.md §4). Facts listed here are the reference points used by the golden-QA fixture.",
    docs: entries,
  };
  const evalDir = path.join(OUT_DIR, "eval");
  mkdirSync(evalDir, { recursive: true });
  writeFileSync(
    path.join(evalDir, "corpus-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  console.info(
    JSON.stringify({
      level: "info",
      module: "corpus-generate",
      msg: "corpus generated",
      docs: entries.length,
      amm: amms.length,
      tsm: tsms.length,
      ipc: ipcs.length,
      sb: writes.filter((w) => w.entry.docType === "SB").length,
    }),
  );
}

main();
