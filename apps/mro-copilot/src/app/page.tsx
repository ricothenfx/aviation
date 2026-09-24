import { Panel, StatTile } from "@aviation/ui";
import { redirect } from "next/navigation";

import { AppPage } from "@/components/app-page";
import { ReadinessPanel } from "@/components/readiness-panel";
import { getSession } from "@/lib/auth/session";

/**
 * Post-login landing (F1 shell): who am I, is the stack ready, what ships when.
 * No simulated operational data yet — corpus/ingest arrives with F2 and is not
 * faked here (data-ethics.md, ui-design-system.md §8.3).
 */
export default async function HomePage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  return (
    <AppPage>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-fg">MRO Copilot</h1>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted">
          Grounded maintenance-manual copilot for the fictional NX-320 fleet with page-level
          citations, refuse-when-ungrounded guardrails, human sign-off and engine-health prediction.
          Signed in as <span className="text-fg">{session.name}</span> · role{" "}
          <span className="font-mono text-accent">{session.role}</span>.
        </p>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile label="Signed-in role" value={session.role} hint="seeded account (D-09)" />
        <StatTile label="Corpus" value="F2" hint="NX-320 synthetic manuals (~40 docs)" />
        <StatTile label="RUL model" value="F4" hint="C-MAPSS GBM artifact (ADR-0011)" />
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-2">
        <ReadinessPanel />
        <Panel title="Build plan (milestones)">
          <ul className="space-y-2 text-xs leading-5 text-muted">
            <li>
              <span className="font-mono text-fg">F1</span> — scaffold, auth + RBAC, pgvector
              schema, ai-service gateway port (this milestone)
            </li>
            <li>
              <span className="font-mono text-fg">F2</span> — NX-320 corpus, ingestion, hybrid
              retrieval, manual browser + search
            </li>
            <li>
              <span className="font-mono text-fg">F3</span> — RAG ask flow, guardrails, reviewer
              sign-off, eval gates
            </li>
            <li>
              <span className="font-mono text-fg">F4</span> — C-MAPSS seed, RUL model, fleet
              dashboard + alerts
            </li>
            <li>
              <span className="font-mono text-fg">F5</span> — load evidence, README, live demo
              deploy
            </li>
          </ul>
        </Panel>
      </div>
    </AppPage>
  );
}
