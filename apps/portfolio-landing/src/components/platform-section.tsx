import { repoLink, DECISION_LOG_PATH, TRACEABILITY_PATH } from "@/lib/projects";

const STACK_CHIPS = [
  "TypeScript (strict)",
  "Next.js 15",
  "Tailwind CSS v4",
  "PostgreSQL + TimescaleDB",
  "Redis pub/sub",
  "pgvector",
  "Python FastAPI (AI serving)",
  "Docker Compose",
  "GitHub Actions",
  "Playwright",
];

const LANES = [
  {
    title: "One monorepo, one design system",
    body:
      "Three apps, six worker services, and shared packages (ui tokens, contracts, db, " +
      "llm-gateway) move together under conventional commits and reviewed PR history.",
  },
  {
    title: "Gates, not vibes",
    body:
      "Every push runs lint (zero warnings), strict typecheck, unit tests, integration suites " +
      "against the real compose stack, and Playwright e2e with visual regression + axe a11y scans.",
  },
  {
    title: "×10 load gates with committed artifacts",
    body:
      "Each system must pass its performance gate at ten times reference scale on a reproducible, " +
      "committed harness — failures are reported and drove real hardening fixes (batched WS " +
      "frames, pooled retrieval, coalesced queue projections).",
  },
  {
    title: "Decisions on the record",
    body:
      "25 decision-log entries and 19 ADRs: every architecture choice, every rejected alternative, " +
      "every post-load finding — including the misses — is written down and traceable.",
  },
];

export function PlatformSection() {
  return (
    <section id="platform" className="border-t border-border bg-surface/40">
      <div className="mx-auto max-w-6xl scroll-mt-16 px-4 py-12">
        <h2 className="text-xl font-semibold tracking-tight text-fg">How it&apos;s built</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          The same platform underneath all three systems — and the same definition of
          &ldquo;done&rdquo;.
        </p>
        <div className="mt-6 flex flex-wrap gap-2" aria-label="Technology stack">
          {STACK_CHIPS.map((chip) => (
            <span
              key={chip}
              className="rounded-full border border-border bg-surface px-3 py-1 font-mono text-xs text-muted"
            >
              {chip}
            </span>
          ))}
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {LANES.map((lane) => (
            <div key={lane.title} className="rounded-lg border border-border bg-surface p-4">
              <h3 className="text-sm font-semibold text-fg">{lane.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{lane.body}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 text-xs text-muted">
          Start with the{" "}
          <a
            className="underline decoration-border underline-offset-2 hover:text-fg"
            href={repoLink(DECISION_LOG_PATH)}
          >
            decision log
          </a>{" "}
          or the{" "}
          <a
            className="underline decoration-border underline-offset-2 hover:text-fg"
            href={repoLink(TRACEABILITY_PATH)}
          >
            JD traceability matrix
          </a>{" "}
          (job requirement → feature → code → test).
        </p>
      </div>
    </section>
  );
}
