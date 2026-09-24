import { AppPage } from "@/components/app-page";
import { PlaceholderScreen } from "@/components/placeholder-screen";

export default function EnginesPage() {
  return (
    <AppPage>
      <PlaceholderScreen
        title="Engine health (RUL)"
        milestone="F4"
        description="Fleet RUL dashboard powered by the public NASA C-MAPSS dataset (Saxena & Goebel 2008): per-unit remaining useful life, degradation trend, maintenance-window alerts with acknowledgment lifecycle."
        items={[
          "Versioned GBM artifact served by ai-service (ADR-0011); provenance on every prediction (FR-16)",
          "Trend chart with labeled axes and synthetic time mapping (data-model.md §8)",
          "Alerts raised → acknowledged → resolved; ≥ 5 cycles lead in fixtures (FR-18)",
        ]}
      />
    </AppPage>
  );
}
