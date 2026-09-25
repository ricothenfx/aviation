import { Suspense } from "react";

import { AppPage } from "@/components/app-page";
import { ManualsBrowser } from "@/components/manuals-browser";

export default function ManualsPage() {
  return (
    <AppPage>
      <Suspense>
        <ManualsBrowser />
      </Suspense>
    </AppPage>
  );
}
