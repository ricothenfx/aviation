import { AppPage } from "@/components/app-page";
import { AnswerDetailScreen, AnswerNotFound } from "@/components/answer-detail";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AnswerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppPage>{UUID_RE.test(id) ? <AnswerDetailScreen id={id} /> : <AnswerNotFound />}</AppPage>
  );
}
