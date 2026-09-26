import { AppPage } from "@/components/app-shell";
import { QueuePanel } from "@/components/queue-panel";

/** Agent console (PRD F-4 surface; F1 shell with mandatory states). */
export default function ConsolePage() {
  return (
    <AppPage minimumRole="agent">
      <div className="rb-fade-in">
        <h1 className="text-lg font-semibold text-fg">Agent console</h1>
        <p className="mt-1 text-xs text-muted">
          Disrupted passengers awaiting re-accommodation — the queue shrinks as passengers
          self-serve.
        </p>
        <div className="mt-4">
          <QueuePanel />
        </div>
      </div>
    </AppPage>
  );
}
