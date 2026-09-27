import { StatusBadge } from "@aviation/ui";

import { PROJECTS, repoLink, type Project } from "@/lib/projects";

function BoardRow({ project }: { project: Project }) {
  return (
    <li className="pl-row border-b border-border last:border-b-0">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 px-3 py-3 sm:grid-cols-[3rem_1fr_1fr_auto_auto] sm:px-4">
        <span className="font-mono text-sm font-semibold text-accent">{project.code}</span>
        <span className="min-w-0">
          <a
            href={project.demoUrl ?? repoLink(project.caseStudy)}
            className="block truncate font-medium text-fg underline-offset-4 hover:text-accent hover:underline"
          >
            {project.name}
          </a>
          <span className="block truncate text-xs text-muted">{project.mission}</span>
        </span>
        <span className="hidden min-w-0 truncate font-mono text-xs tabular-nums text-muted sm:block">
          <span className="text-fg">{project.board.value}</span>
          {" \u00b7 "}
          {project.board.note}
        </span>
        <StatusBadge tone={project.status === "live" ? "ok" : "warn"}>
          {project.status === "live" ? "LIVE" : "PREPARING"}
        </StatusBadge>
        {project.demoUrl ? (
          <a
            href={project.demoUrl}
            className="justify-self-end rounded-md border border-accent/40 px-2.5 py-1 font-mono text-xs text-accent transition-colors duration-150 hover:bg-accent/10"
          >
            OPEN →
          </a>
        ) : (
          <span className="justify-self-end font-mono text-xs text-muted">PENDING</span>
        )}
      </div>
    </li>
  );
}

/** The centerpiece: a departures-board-style index of the three systems. */
export function FlightBoard() {
  return (
    <section
      aria-label="Portfolio systems board"
      className="rounded-xl border border-border bg-surface"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-muted">
          Operations board — three systems
        </h2>
        <span className="font-mono text-xs text-muted">
          SIN · refreshed {new Date().getFullYear()}
        </span>
      </div>
      <div className="hidden grid-cols-[3rem_1fr_1fr_auto_auto] gap-x-4 border-b border-border px-4 py-1.5 font-mono text-[11px] uppercase tracking-widest text-muted sm:grid">
        <span>Code</span>
        <span>System</span>
        <span>Headline metric</span>
        <span>Status</span>
        <span>Demo</span>
      </div>
      <ul>
        {PROJECTS.map((project) => (
          <BoardRow key={project.slug} project={project} />
        ))}
      </ul>
    </section>
  );
}
