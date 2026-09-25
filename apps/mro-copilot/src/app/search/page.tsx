import { Suspense } from "react";

import { AppPage } from "@/components/app-page";
import { SearchPanel } from "@/components/search-panel";

export default function SearchPage() {
  return (
    <AppPage>
      <Suspense>
        <SearchPanel />
      </Suspense>
    </AppPage>
  );
}
