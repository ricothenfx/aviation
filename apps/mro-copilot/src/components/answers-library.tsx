"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, EmptyState, ErrorState, Panel, Skeleton, StatusBadge } from "@aviation/ui";

import { ApiClientError, apiGet } from "@/lib/client/api";
import { answersResponseSchema, type AnswerSummary } from "@/lib/api/schemas";

/**
 * Verified-answer library + lifecycle list (PRD FR-15, US-6; api-contracts.md
 * §1 GET /answers). Visibility is role-scoped server-side: viewers see only
 * approved answers; engineers also see their own drafts/refusals/rejections;
 * reviewers see everything.
 */

const FILTERS = [
  { value: "", label: "All visible" },
  { value: "approved", label: "Verified library" },
  { value: "draft", label: "Drafts" },
  { value: "refused", label: "Refusals" },
  { value: "rejected", label: "Rejected" },
] as const;

export function AnswersLibrary() {
  return (
    <Panel title="Answers · verified library & lifecycle" className="min-h-[70vh]">
      <Library />
    </Panel>
  );
}

function Library() {
  const [filter, setFilter] = useState<string>("");
  const [answers, setAnswers] = useState<AnswerSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);

  const load = useCallback(async (status: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const data = await apiGet(
        `/api/v1/answers?${params.toString()}`,
        answersResponseSchema.parse,
      );
      setAnswers(data.answers);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : "failed to load answers",
        requestId: err instanceof ApiClientError ? err.requestId : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Answer filters">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={
              filter === f.value
                ? "rounded-full border border-accent/50 bg-raised px-3 py-1 text-xs font-medium text-accent"
                : "rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:border-accent/40 hover:text-fg"
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? (
        <ErrorState
          title="Answers unavailable"
          message={error.message}
          requestId={error.requestId}
          action={
            <Button size="sm" onClick={() => void load(filter)}>
              Retry
            </Button>
          }
        />
      ) : loading && answers === null ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      ) : answers !== null && answers.length === 0 ? (
        <EmptyState
          title={filter === "approved" ? "No verified answers yet" : "No answers yet"}
          body="Approved answers enter the verified library after reviewer sign-off. Engineers create drafts from the Copilot screen."
        />
      ) : (
        <ul className="space-y-2" data-testid="answer-list">
          {(answers ?? []).map((answer) => (
            <AnswerRow key={answer.id} answer={answer} />
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS_TONES = {
  approved: "ok",
  draft: "info",
  refused: "warn",
  rejected: "danger",
} as const;

function AnswerRow({ answer }: { answer: AnswerSummary }) {
  return (
    <li className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={STATUS_TONES[answer.status]}>
          {answer.status === "approved" ? "verified" : answer.status}
        </StatusBadge>
        {answer.status !== "refused" && answer.status !== "approved" ? (
          <StatusBadge tone="muted">
            {answer.source === "llm" ? `llm · ${answer.provider}` : `source: ${answer.source}`}
          </StatusBadge>
        ) : null}
        <span className="font-mono text-[10px] text-muted">
          grounding {answer.groundingScore.toFixed(3)} · {answer.citationCount} citation
          {answer.citationCount === 1 ? "" : "s"}
        </span>
        <span className="ml-auto text-[11px] text-muted">
          {answer.createdByName} · {new Date(answer.createdAt).toLocaleDateString("en-GB")}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-fg" data-testid="answer-question">
        {answer.question}
      </p>
      {answer.review ? (
        <p className="mt-1 text-xs text-muted">
          {answer.status === "rejected" && answer.review.note
            ? `Rejected by ${answer.review.reviewerName}: “${answer.review.note}”`
            : `Signed off by ${answer.review.reviewerName} · ${new Date(answer.review.at).toLocaleString("en-GB")}`}
        </p>
      ) : null}
      {answer.status === "refused" && answer.refusalReason ? (
        <p className="mt-1 font-mono text-[10px] text-muted">reason: {answer.refusalReason}</p>
      ) : null}
      <div className="mt-1.5">
        <Link
          href={`/answers/${answer.id}`}
          className="text-xs font-medium text-accent underline-offset-2 hover:underline"
        >
          Open detail →
        </Link>
      </div>
    </li>
  );
}
