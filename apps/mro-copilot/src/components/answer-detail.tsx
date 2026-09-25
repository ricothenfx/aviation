"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, EmptyState, ErrorState, Panel, Skeleton, StatusBadge } from "@aviation/ui";

import { ApiClientError, apiGet } from "@/lib/client/api";
import {
  answerDetailSchema,
  auditEventSchema,
  type AnswerDetail,
  type AuditEvent,
} from "@/lib/api/schemas";

/**
 * Answer detail + append-only audit trail (api-contracts.md §1
 * /answers/{id} + /answers/{id}/audit). The lifecycle is replayable from the
 * events (PRD F-4: "full lifecycle replayable from audit events").
 */
export function AnswerDetailScreen({ id }: { id: string }) {
  const [detail, setDetail] = useState<AnswerDetail | null>(null);
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [loadSeq, setLoadSeq] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      apiGet(`/api/v1/answers/${id}`, answerDetailSchema.parse),
      apiGet(`/api/v1/answers/${id}/audit`, (raw: unknown) =>
        (raw as { events: unknown[] }).events.map((e) => auditEventSchema.parse(e)),
      ),
    ])
      .then(([d, a]) => {
        if (!cancelled) {
          setDetail(d);
          setAudit(a);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError({
            message: err instanceof Error ? err.message : "failed to load answer",
            requestId: err instanceof ApiClientError ? err.requestId : undefined,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, loadSeq]);

  if (error) {
    return (
      <ErrorState
        title="Answer unavailable"
        message={error.message}
        requestId={error.requestId}
        action={
          <Button size="sm" onClick={() => setLoadSeq((n) => n + 1)}>
            Retry
          </Button>
        }
      />
    );
  }
  if (!detail || audit === null) {
    return (
      <div className="space-y-3" aria-hidden>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Panel title="Answer detail">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              tone={
                detail.status === "approved"
                  ? "ok"
                  : detail.status === "rejected"
                    ? "danger"
                    : detail.status === "refused"
                      ? "warn"
                      : "info"
              }
            >
              {detail.status}
            </StatusBadge>
            <StatusBadge tone="muted">
              {detail.source === "llm"
                ? `source: llm · provider ${detail.provider}`
                : `source: ${detail.source}`}
            </StatusBadge>
            <span className="font-mono text-[10px] text-muted">
              grounding {detail.groundingScore.toFixed(3)} · {detail.retrievalMeta.mode} ·{" "}
              {detail.retrievalMeta.topK} chunks · {detail.retrievalMeta.latencyMs} ms
            </span>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Question</p>
            <p className="text-sm font-medium text-fg">{detail.question}</p>
          </div>
          {detail.answerText ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Answer</p>
              <p className="whitespace-pre-line rounded-md border border-border bg-raised/40 p-3 text-xs leading-5 text-fg/90">
                {detail.answerText}
              </p>
            </div>
          ) : detail.refusalReason ? (
            <p className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
              Refused — reason: <span className="font-mono">{detail.refusalReason}</span>. No answer
              or citations were produced (FR-10).
            </p>
          ) : null}
          {detail.citations.length > 0 ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                Citations
              </p>
              <ul className="mt-1 space-y-1.5">
                {detail.citations.map((citation, i) => (
                  <li key={citation.chunkId} className="text-xs">
                    <span className="mr-1 font-mono text-accent">[{i + 1}]</span>
                    <StatusBadge tone="muted">{citation.docType}</StatusBadge>{" "}
                    <span className="font-mono font-semibold">{citation.taskNo || "—"}</span>{" "}
                    <span className="font-mono text-[10px] text-muted">
                      ATA {citation.ataChapter} · p.{citation.page} · {citation.revision}
                    </span>
                    <div>
                      <Link
                        href={`/manuals?manual=${citation.manualId}&chunk=${citation.chunkId}`}
                        className="text-accent underline-offset-2 hover:underline"
                      >
                        Open in manual browser →
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {detail.review ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Review</p>
              <p className="text-xs text-muted">
                {detail.status === "rejected" && detail.review.note
                  ? `Rejected by ${detail.review.reviewerName} — note: “${detail.review.note}”`
                  : `Approved by ${detail.review.reviewerName}`}{" "}
                · {new Date(detail.review.at).toLocaleString("en-GB")}
              </p>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="Audit trail (append-only)">
        <ol className="space-y-2">
          {audit.map((event) => (
            <li
              key={event.id}
              className="flex flex-wrap items-baseline gap-2 text-xs"
              data-testid="audit-event"
            >
              <span className="font-mono text-[10px] text-muted">#{event.sequence}</span>
              <span className="font-mono font-semibold text-fg">{event.eventType}</span>
              <span className="text-muted">
                {event.actorName ?? "system"} · {new Date(event.createdAt).toLocaleString("en-GB")}
              </span>
            </li>
          ))}
          {audit.length === 0 ? <li className="text-xs text-muted">No events recorded.</li> : null}
        </ol>
      </Panel>

      <div>
        <Link href="/answers" className="text-xs text-accent underline-offset-2 hover:underline">
          ← Back to answers
        </Link>
      </div>
    </div>
  );
}

export function AnswerNotFound() {
  return (
    <EmptyState
      title="Answer not found"
      body="The answer id does not exist or is not visible to your role."
    />
  );
}
