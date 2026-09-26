import { AppPage } from "@/components/app-page";
import { EvalsHistory } from "@/components/evals-history";
import { IngestPanel } from "@/components/ingest-panel";

export default function EvalsPage() {
  return (
    <AppPage>
      <EvalsHistory />
      <IngestPanel />
    </AppPage>
  );
}
