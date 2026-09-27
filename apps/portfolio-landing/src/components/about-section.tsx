import { repoLink, DATA_ETHICS_PATH, repoRoot } from "@/lib/projects";

export function AboutSection() {
  return (
    <section id="about" className="border-t border-border bg-surface/40">
      <div className="mx-auto max-w-6xl scroll-mt-16 px-4 py-12">
        <div className="grid gap-8 lg:grid-cols-2">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-fg">About this portfolio</h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              This is a job-application portfolio for software engineering roles in Singapore
              aviation — airport operations, maintenance, and passenger systems. It is built in the
              open: the repository contains the specs (PRDs, architecture, data models, API
              contracts), the milestone reports, the decision log, and every benchmark artifact.
            </p>
            <p className="mt-3 text-sm leading-6 text-muted">
              Seniors are hired for judgment, so the trade-offs are the content: why event sourcing
              over CRUD, why PostgreSQL with JSONB over a second database engine, why the LLM only
              proposes and humans approve — each written down as an ADR with the rejected
              alternatives.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <a href={repoRoot()}>
                <span className="inline-flex h-9 items-center rounded-md border border-accent/40 px-4 text-sm font-medium text-accent transition-colors duration-150 hover:bg-accent/10">
                  Open the repository
                </span>
              </a>
              <a
                href={repoLink("blob/main/docs/00-context/traceability-matrix.md")}
                className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium text-fg transition-colors duration-150 hover:bg-raised"
              >
                Requirement traceability
              </a>
            </div>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-muted">
              Data ethics — read before you demo
            </h3>
            <ul className="mt-3 list-disc space-y-2 pl-4 text-sm leading-6 text-muted">
              <li>
                All operational data in every system is{" "}
                <strong className="text-fg">simulated</strong> and labeled as such on every screen —
                synthetic schedules, a fictional airline code (NX), fictional people.
              </li>
              <li>
                No affiliation with, or endorsement from, any real company is claimed; no real
                logos, PNRs, or passenger records exist anywhere in the repo.
              </li>
              <li>
                Allowed datasets only: NASA C-MAPSS (engine health), OurAirports, hand-written
                scenarios.
              </li>
              <li>
                Benchmarks are reported honestly — including the runs that failed and what they
                caused to be fixed.
              </li>
            </ul>
            <a
              className="mt-3 inline-block text-xs text-accent underline-offset-2 hover:underline"
              href={repoLink(DATA_ETHICS_PATH)}
            >
              data-ethics.md — the binding policy
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
