import { AppPage } from "@/components/app-page";
import { PlaceholderScreen } from "@/components/placeholder-screen";

export default function ManualsPage() {
  return (
    <AppPage>
      <PlaceholderScreen
        title="Manual library"
        milestone="F2"
        description="The synthetic NX-320 manual library (AMM task cards, IPC figures, TSM fault isolation, service bulletins) with ATA-chapter navigation and revision metadata lands with corpus ingestion."
        items={[
          "TOC navigation by doc type and ATA chapter (data-model.md §4)",
          "Chunk view with breadcrumb, fictional page and revision (FR-6)",
          "Idempotent ingest with hash-verified chunks (FR-5)",
        ]}
      />
    </AppPage>
  );
}
