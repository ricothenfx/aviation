import { AppPage } from "@/components/app-page";
import { PlaceholderScreen } from "@/components/placeholder-screen";

export default function ReviewsPage() {
  return (
    <AppPage>
      <PlaceholderScreen
        title="Review queue"
        milestone="F3"
        description="Reviewer workspace for drafted answers: citations side-by-side, approve/reject with mandatory note, append-only audit and the verified-answer library."
        items={[
          "Reviewer-only access; engineers can never approve (RBAC + FR-14)",
          "Self-approval blocked — separation of duties enforced server-side",
          "Append-only audit events for every lifecycle transition",
        ]}
      />
    </AppPage>
  );
}
