import { StatusBadge } from "@aviation/ui";

import { PROJECTS, repoLink, type Project, type ProjectMetric } from "@/lib/projects";

function MetricTile({ metric }: { metric: ProjectMetric }) {
  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface px-3 py-3">
      <div className="font-mono text-xl leading-7 tabular-nums text-fg">{metric.value}</div>
      <div className="mt-1 text-xs leading-5 text-muted">{metric.label}</div>
      <a
        href={repoLink(`blob/main/${metric.source}`)}
        className="mt-2 text-[11px] text-accent underline-offset-2 hover:underline"
      >
        evidence: {metric.source.split("/").pop()}
      </a>
    </div>
  );
}

function DemoAction({ project }: { project: Project }) {
  if (project.demoUrl) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <a href={project.demoUrl}>
          <span className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-[#06121f] transition-[filter] duration-150 hover:brightness-110">
            Open the live demo →
          </span>
        </a>
        <span className="font-mono text-xs text-muted">
          live since {project.liveSince} · {project.demoHostname}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusBadge tone="warn">Demo deployment pending</StatusBadge>
      <span className="font-mono text-xs text-muted">
        will serve at {project.demoHostname} ·{" "}
        <a
          className="underline decoration-border underline-offset-2 hover:text-fg"
          href={repoLink(
            `blob/main/infra/deploy/${project.slug === "mro-copilot" ? "mro" : "rebook"}/README.md`,
          )}
        >
          runbook ready
        </a>
      </span>
    </div>
  );
}

function ProjectSection({ project, flip }: { project: Project; flip: boolean }) {
  return (
    <article
      id={project.slug}
      className="grid scroll-mt-16 gap-8 border-t border-border py-12 lg:grid-cols-2 lg:gap-10"
    >
      <div className={flip ? "lg:order-2" : ""}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-xs font-semibold text-accent">
            {project.code} · {String(project.buildOrder).padStart(2, "0")}
          </span>
          <StatusBadge tone={project.status === "live" ? "ok" : "warn"}>
            {project.status === "live" ? "LIVE" : "PREPARING"}
          </StatusBadge>
        </div>
        <h3 className="mt-2 text-2xl font-semibold tracking-tight text-fg">{project.name}</h3>
        <p className="mt-1 text-sm font-medium text-fg/90">{project.mission}</p>
        <p className="mt-4 text-sm leading-6 text-muted">{project.domainStory}</p>
        <p className="mt-3 border-l-2 border-accent/40 pl-3 text-sm leading-6 text-muted">
          <span className="font-medium text-fg">For the engineering reviewer: </span>
          {project.engineering}
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {project.metrics.map((metric) => (
            <MetricTile key={metric.label} metric={metric} />
          ))}
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-4 text-sm">
          <DemoAction project={project} />
        </div>
        <p className="mt-4 text-xs text-muted">
          Case study:{" "}
          <a
            className="underline decoration-border underline-offset-2 hover:text-fg"
            href={repoLink(project.caseStudy)}
          >
            PRD → milestones →{" "}
            {project.slug === "mro-copilot" ? "eval + load reports" : "load report"} (GitHub)
          </a>
        </p>
      </div>
      <figure className={flip ? "lg:order-1" : ""}>
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <img
            src={project.screenshot}
            alt={project.screenshotAlt}
            width={1280}
            height={720}
            loading="lazy"
            className="h-auto w-full object-cover"
          />
        </div>
        <figcaption className="mt-2 text-xs text-muted">
          {project.screenshotAlt} — simulated data.
        </figcaption>
      </figure>
    </article>
  );
}

export function SystemsSection() {
  return (
    <section id="systems" className="mx-auto max-w-6xl scroll-mt-16 px-4">
      <h2 className="pt-12 text-xl font-semibold tracking-tight text-fg">The three systems</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
        Built in locked order over four weeks — each project scoped by a PRD, gated by five
        milestones with hard Definitions of Done, and shipped only when its load or evaluation gate
        passed on a committed, reproducible harness.
      </p>
      {PROJECTS.map((project, index) => (
        <ProjectSection key={project.slug} project={project} flip={index % 2 === 1} />
      ))}
    </section>
  );
}
