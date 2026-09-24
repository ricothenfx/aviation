import { AppPage } from "@/components/app-page";
import { PlaceholderScreen } from "@/components/placeholder-screen";

export default function SearchPage() {
  return (
    <AppPage>
      <PlaceholderScreen
        title="Hybrid search"
        milestone="F2"
        description="Hybrid retrieval (pgvector semantic + tsvector lexical, RRF-fused per ADR-0010) with doc-type and ATA filters, highlighted snippets and a visible retrieval-mode flag."
        items={[
          "Hybrid → lexical degradation ladder, mode disclosed in the UI (FR-7)",
          "p95 < 300 ms at reference scale on the compose stack (FR-8)",
          "Filters: doc type, ATA chapter, revision applicability",
        ]}
      />
    </AppPage>
  );
}
