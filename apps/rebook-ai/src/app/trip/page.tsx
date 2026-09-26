import { AppPage } from "@/components/app-shell";
import { TripPanel } from "@/components/trip-panel";

/** Passenger home (PRD F-1/F-2 surface; F1 shell with mandatory states). */
export default function TripPage() {
  return (
    <AppPage>
      <div className="rb-fade-in">
        <h1 className="text-lg font-semibold text-fg">My trip</h1>
        <p className="mt-1 text-xs text-muted">
          Disruption options appear here automatically — no queueing required.
        </p>
        <div className="mt-4">
          <TripPanel />
        </div>
      </div>
    </AppPage>
  );
}
