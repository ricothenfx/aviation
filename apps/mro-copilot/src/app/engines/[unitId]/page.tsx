import { AppPage } from "@/components/app-page";
import { EngineDetail } from "@/components/engine-detail";

export default async function EngineUnitPage({ params }: { params: Promise<{ unitId: string }> }) {
  const { unitId } = await params;
  return (
    <AppPage>
      <EngineDetail unitId={decodeURIComponent(unitId)} />
    </AppPage>
  );
}
