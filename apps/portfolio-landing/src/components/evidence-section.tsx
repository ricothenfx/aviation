import { PROJECTS, GATES, repoLink } from "@/lib/projects";

export function EvidenceSection() {
  return (
    <section id="evidence" className="border-t border-border">
      <div className="mx-auto max-w-6xl scroll-mt-16 px-4 py-12">
        <h2 className="text-xl font-semibold tracking-tight text-fg">Measured, not claimed</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          Every gate below ran on a committed harness you can re-run. Where a gate was missed, the
          miss is quantified and root-caused — that is the point.
        </p>
        <div className="mt-6 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <caption className="sr-only">Performance and evaluation gates per system</caption>
            <thead>
              <tr className="border-b border-border bg-surface font-mono text-[11px] uppercase tracking-widest text-muted">
                <th scope="col" className="px-4 py-2 font-medium">
                  System
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Gate
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Result
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Report
                </th>
              </tr>
            </thead>
            <tbody>
              {PROJECTS.map((project) => {
                const gate = GATES[project.slug];
                return (
                  <tr
                    key={project.slug}
                    className="border-b border-border last:border-b-0 align-top"
                  >
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-accent">{project.code}</span>{" "}
                      <span className="font-medium text-fg">{project.name}</span>
                      <div className="mt-1 text-xs text-muted">{gate.verdict}</div>
                    </td>
                    <td className="px-4 py-3 text-muted">{gate.gate}</td>
                    <td className="px-4 py-3 font-mono text-xs tabular-nums text-fg">
                      {gate.result}
                    </td>
                    <td className="px-4 py-3">
                      <a
                        className="text-xs text-accent underline-offset-2 hover:underline"
                        href={repoLink(`blob/main/${gate.report}`)}
                      >
                        full report
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          mro-copilot gates are consolidated in{" "}
          <a
            className="underline decoration-border underline-offset-2 hover:text-fg"
            href={repoLink("blob/main/docs/04-projects/mro-copilot/final-eval-report-f5.md")}
          >
            final-eval-report-f5.md
          </a>
          , including the load-gate latency discussion.
        </p>
      </div>
    </section>
  );
}
