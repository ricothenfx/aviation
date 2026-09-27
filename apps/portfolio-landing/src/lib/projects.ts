/**
 * Single source of truth for the landing page (ADR-0019 §Decision 4).
 * Every status badge, demo URL, screenshot and metric on the page renders from
 * here. Honesty rules (D-07):
 *   - `live` status requires an https demoUrl that was verified at deploy time;
 *     `prepared` projects render "deployment pending" and get NO demo link.
 *   - Every metric must cite a committed report path in this repository.
 * `src/lib/projects.test.ts` pins both invariants; update this file (and its
 * test) as part of each live-deploy checklist.
 */

export type ProjectStatus = "live" | "prepared";

export type ProjectSlug = "turnaround-iq" | "mro-copilot" | "rebook-ai";

/** The F5 gate each system passed, with its committed report (evidence section). */
export interface ProjectGate {
  gate: string;
  result: string;
  verdict: "PASS" | "PASS with documented miss";
  /** Repo-relative report path linked from the table. */
  report: string;
}

export interface ProjectMetric {
  value: string;
  label: string;
  /** Repo-relative path of the committed report this number comes from. */
  source: string;
}

export interface Project {
  /** Board code shown on the flight strip. */
  code: string;
  slug: ProjectSlug;
  name: string;
  /** Aviation-domain one-liner (for the domain reader). */
  mission: string;
  /** Short board line rendered on the departures strip. */
  board: { value: string; note: string };
  /** What the engineering reviewer should notice first. */
  engineering: string;
  /** Domain story: the operational problem, told plainly. */
  domainStory: string;
  status: ProjectStatus;
  /** https demo URL — only when status is "live". */
  demoUrl: string | null;
  /** Live-demo date for "live" projects (ISO), else null. */
  liveSince: string | null;
  /** Public demo hostname, shown even while deployment is pending. */
  demoHostname: string;
  /** Repo-relative spec directory linked as the case study. */
  caseStudy: string;
  metrics: ProjectMetric[];
  /** Public asset path of the screenshot, from /public. */
  screenshot: string;
  screenshotAlt: string;
  /** Repo-relative build-order position (D-02), for the board row. */
  buildOrder: number;
}

const REPO_URL = "https://github.com/ricothenfx/aviation";

export function repoLink(repoRelative: string): string {
  return `${REPO_URL}/${repoRelative}`;
}

export function repoRoot(): string {
  return REPO_URL;
}

export const PROJECTS: Project[] = [
  {
    code: "TIQ",
    slug: "turnaround-iq",
    name: "turnaround-iq",
    mission: "AI-assisted aircraft turnaround command center",
    board: { value: "198 ms", note: "board p95 at \u00d710 scale" },
    engineering:
      "Event-sourced ground-task log; a realtime gateway projects events into Redis and " +
      "broadcasts batched WebSocket deltas; a constraint scheduler re-sequences tasks on " +
      "disruption; the LLM only explains the proposal — humans approve it.",
    domainStory:
      "Every turnaround is a race against departure time. When a baggage loader breaks down, " +
      "coordinators find out late and re-plan by hand. turnaround-iq raises the alert 10+ " +
      "minutes before the SLA breaches, proposes a re-sequenced plan that cuts a 47-minute " +
      "delay to 9 — with the full \u201cwhy was this flight late\u201d trail auditors ask for.",
    status: "live",
    demoUrl: "https://turnaround-iq.aviation.ricothen.com",
    liveSince: "2026-09-24",
    demoHostname: "turnaround-iq.aviation.ricothen.com",
    caseStudy: "tree/main/docs/04-projects/turnaround-iq",
    metrics: [
      {
        value: "198 ms",
        label:
          "ingestion \u2192 board p95 at \u00d710 scale, 200 concurrent WS consumers (gate: < 1 s)",
        source: "docs/04-projects/turnaround-iq/load-report-f5.md",
      },
      {
        value: "100.0%",
        label: "frame delivery across 3,000,000 frames / 200 consumers",
        source: "docs/04-projects/turnaround-iq/load-report-f5.md",
      },
      {
        value: "47 \u2192 9 min",
        label: "loader-breakdown delay, replanned in < 2 s",
        source: "docs/04-projects/turnaround-iq/load-report-f5.md",
      },
    ],
    screenshot: "/screenshots/turnaround-iq-board.gif",
    screenshotAlt:
      "turnaround-iq live board: simulated day ticking, loader breakdown injected, AI replan approved",
    buildOrder: 1,
  },
  {
    code: "MRO",
    slug: "mro-copilot",
    name: "mro-copilot",
    mission: "Maintenance-manual RAG copilot + engine health",
    board: { value: "0.923", note: "retrieval recall@5 (gate 0.85)" },
    engineering:
      "Hybrid lexical/semantic retrieval over a pgvector store (RRF fusion), answers gated by " +
      "citation guardrails that refuse when evidence is missing, and a deterministic " +
      "gradient-boosting RUL model with versioned, hash-pinned artifacts.",
    domainStory:
      "Line engineers dig through hundreds of manual pages mid-task, and health warnings on " +
      "engines surface too late. mro-copilot answers with citations a reviewer can approve, " +
      "and forecasts remaining useful life on the NASA C-MAPSS benchmark next to published " +
      "baselines — gaps included, not hidden.",
    status: "prepared",
    demoUrl: null,
    liveSince: null,
    demoHostname: "mro-copilot.aviation.ricothen.com",
    caseStudy: "tree/main/docs/04-projects/mro-copilot",
    metrics: [
      {
        value: "0.923",
        label: "golden retrieval recall@5 over 52 QA cases (gate: \u2265 0.85)",
        source: "docs/04-projects/mro-copilot/final-eval-report-f5.md",
      },
      {
        value: "100%",
        label:
          "refusal accuracy + citation validity (132 citations, all resolve to retrieved chunks)",
        source: "docs/04-projects/mro-copilot/final-eval-report-f5.md",
      },
      {
        value: "RMSE 18.49",
        label:
          "FD001 remaining useful life vs published LSTM 16.14 — the determinism trade-off, stated",
        source: "docs/04-projects/mro-copilot/final-eval-report-f5.md",
      },
    ],
    screenshot: "/screenshots/mro-copilot-ask-grounded.png",
    screenshotAlt: "mro-copilot grounded answer with resolvable citation chips",
    buildOrder: 2,
  },
  {
    code: "RBK",
    slug: "rebook-ai",
    name: "rebook-ai",
    mission: "Passenger disruption concierge",
    board: { value: "9.7 s", note: "offer pipeline p95 at \u00d710 scale" },
    engineering:
      "A propose-only agent loop (read-only tools, bounded rounds, persisted trace) with " +
      "role-gated human approval; fulfillment runs as a compensable saga " +
      "(seat_reserve \u2192 payment \u2192 ticket_issue) with exactly-one-effect idempotency.",
    domainStory:
      "When a flight cancels, passengers queue at the desk while agents rebook by hand. " +
      "rebook-ai ranks realistic rebooking offers per passenger in seconds and lets them " +
      "self-serve to a boarding pass — the agent approves, the saga guarantees no double " +
      "charges even when confirmations race.",
    status: "prepared",
    demoUrl: null,
    liveSince: null,
    demoHostname: "rebook-ai.aviation.ricothen.com",
    caseStudy: "tree/main/docs/04-projects/rebook-ai",
    metrics: [
      {
        value: "9.7 s",
        label:
          "offer pipeline p95 at \u00d710 disruption scale, 50 flights / 250 PNRs (gate: < 10 s)",
        source: "docs/04-projects/rebook-ai/load-report-f5.md",
      },
      {
        value: "0.79 s",
        label: "queue live-update p95 (gate: < 1 s)",
        source: "docs/04-projects/rebook-ai/load-report-f5.md",
      },
      {
        value: "96 racers",
        label:
          "concurrent confirms: exactly 1 confirmation, 1 saga, 1 payment per offer — 0 stuck sagas",
        source: "docs/04-projects/rebook-ai/load-report-f5.md",
      },
    ],
    screenshot: "/screenshots/rebook-ai-passenger-offers.png",
    screenshotAlt: "rebook-ai passenger view: ranked rebooking offers with fare and policy details",
    buildOrder: 3,
  },
];

export const TRACEABILITY_PATH = "blob/main/docs/00-context/traceability-matrix.md";
export const DATA_ETHICS_PATH = "blob/main/docs/02-standards/data-ethics.md";
export const DECISION_LOG_PATH = "blob/main/docs/01-decisions/decision-log.md";

export const GATES: Record<ProjectSlug, ProjectGate> = {
  "turnaround-iq": {
    gate: "\u00d710 events, 200 concurrent WS consumers: ingestion \u2192 board p95 < 1 s",
    result: "198 ms, 100.0% frame delivery (3.0M frames)",
    verdict: "PASS",
    report: "docs/04-projects/turnaround-iq/load-report-f5.md",
  },
  "mro-copilot": {
    gate: "Golden retrieval recall@5 \u2265 0.85 \u00b7 refusal 100% \u00b7 citations resolve 100%",
    result: "0.923 \u00b7 1.00 \u00b7 1.00 (52 QA cases, 132 citations)",
    verdict: "PASS",
    report: "docs/04-projects/mro-copilot/final-eval-report-f5.md",
  },
  "rebook-ai": {
    gate: "\u00d710 disruption wave: offer pipeline p95 < 10 s \u00b7 queue update p95 < 1 s",
    result: "9.7 s paced (burst miss documented: 14.9 s, root-caused) \u00b7 0.79 s",
    verdict: "PASS with documented miss",
    report: "docs/04-projects/rebook-ai/load-report-f5.md",
  },
};
