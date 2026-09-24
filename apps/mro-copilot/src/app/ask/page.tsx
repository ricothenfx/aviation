import { AppPage } from "@/components/app-page";
import { PlaceholderScreen } from "@/components/placeholder-screen";

export default function AskPage() {
  return (
    <AppPage>
      <PlaceholderScreen
        title="Copilot ask"
        milestone="F3"
        description="The RAG ask flow: retrieval → prompt assembly → llm-gateway → guardrail validation → cited draft, with explicit refusal when the corpus cannot ground an answer."
        items={[
          "Every claim cited to a manual chunk; hallucinated citations stripped (FR-11)",
          "Refusal with machine-readable reason below the grounding threshold (FR-10)",
          "Source honesty badge: llm vs extractive, provider disclosed (FR-12)",
          "Reviewer sign-off lifecycle draft → approved | rejected (FR-14)",
        ]}
      />
    </AppPage>
  );
}
