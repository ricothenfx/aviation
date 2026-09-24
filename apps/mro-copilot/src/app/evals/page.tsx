import { AppPage } from "@/components/app-page";
import { PlaceholderScreen } from "@/components/placeholder-screen";

export default function EvalsPage() {
  return (
    <AppPage>
      <PlaceholderScreen
        title="Eval dashboard"
        milestone="F3+"
        description="Read-only eval run history for reviewers: retrieval recall@5, refusal accuracy, citation validity and grounded answer rate — every number traceable to a committed fixture version."
        items={[
          "Golden QA (≥ 50) + refusal set (≥ 20) as versioned fixtures (FR-19)",
          "CI gates: recall@5 ≥ 0.85, refusal 100%, citation validity 100%, grounded ≥ 80%",
          "Bad results reported alongside good ones (data-ethics.md §4)",
        ]}
      />
    </AppPage>
  );
}
