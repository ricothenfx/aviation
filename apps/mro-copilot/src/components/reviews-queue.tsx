"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Panel,
  Skeleton,
  StatusBadge,
} from "@aviation/ui";

import { ApiClientError, apiGet, apiPost } from "@/lib/client/api";
import {
  answerDetailSchema,
  reviewQueueResponseSchema,
  type AnswerDetail,
} from "@/lib/api/schemas";

/**
 * Reviewer workspace (PRD US-6, F-4; api-contracts.md §1 reviews): drafted
 * answers with citations side-by-side, approve / reject (mandatory note).
 * RBAC is server-side — this screen only renders the reviewer's queue.
 */

export function ReviewsQueue() {
  return (
    <Panel title="Review queue · drafts awaiting sign-off" className="min-h-[70vh]">
      <Queue />
    </Panel>
  );
}

function Queue() {
  const [queue, setQueue] = useState<AnswerDetail[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet("/api/v1/reviews/queue", reviewQueueResponseSchema.parse);
      setQueue(data.queue);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : "failed to load queue",
        requestId: err instanceof ApiClientError ? err.requestId : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: "approve" | "reject", note?: string) {
    setBusyId(id);
    setError(null);
    try {
      await apiPost(
        `/api/v1/answers/${id}/${action}`,
        note === undefined ? {} : { note },
        answerDetailSchema.parse,
      );
      setQueue((q) => q?.filter((item) => item.id !== id) ?? q);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : `${action} failed`,
        requestId: err instanceof ApiClientError ? err.requestId : undefined,
      });
    } finally {
      setBusyId(null);
    }
  }

  if (error && queue === null) {
    return (
      <ErrorState
        title="Queue unavailable"
        message={error.message}
        requestId={error.requestId}
        action={
          <Button size="sm" onClick={() => void load()}>
            Retry
          </Button>
        }
      />
    );
  }
  if (loading && queue === null) {
    return (
      <div className="space-y-3" aria-hidden>
        {[0, 1].map((i) => (
          <div key={i} className="space-y-2 rounded-lg border border-border p-4">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    );
  }
  if (queue !== null && queue.length === 0 && !error) {
    return (
      <EmptyState
        title="Queue clear"
        body="No drafts are awaiting sign-off. When an engineer asks the copilot a question that grounds, the draft appears here for approve/reject with a note."
      />
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger"
        >
          {error.message} {error.requestId ? `(${error.requestId})` : ""}
        </p>
      ) : null}
      {(queue ?? []).map((item) => (
        <QueueItem
          key={item.id}
          item={item}
          busy={busyId === item.id}
          onApprove={() => void act(item.id, "approve")}
          onReject={(note) => void act(item.id, "reject", note)}
        />
      ))}
    </div>
  );
}

function QueueItem({
  item,
  busy,
  onApprove,
  onReject,
}: {
  item: AnswerDetail;
  busy: boolean;
  onApprove: () => void;
  onReject: (note: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  function submitReject() {
    if (note.trim().length < 3) {
      setNoteError("A note is mandatory on reject (FR-14) — say why the draft is not acceptable.");
      return;
    }
    setNoteError(null);
    onReject(note.trim());
  }

  return (
    <article
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      data-testid="queue-item"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={item.source === "llm" ? "info" : "warn"}>
          {item.source === "llm" ? `llm · ${item.provider}` : "extractive"}
        </StatusBadge>
        <StatusBadge tone="muted">{item.retrievalMeta.mode}</StatusBadge>
        <span className="font-mono text-[10px] text-muted">
          grounding {item.groundingScore.toFixed(3)}
        </span>
        <span className="ml-auto text-[11px] text-muted">
          by <span className="font-medium text-fg">{item.createdByName}</span> ·{" "}
          {new Date(item.createdAt).toLocaleString("en-GB")}
        </span>
      </div>

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Question</p>
        <p className="text-sm font-medium text-fg" data-testid="queue-question">
          {item.question}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Draft answer
          </p>
          <p className="whitespace-pre-line rounded-md border border-border bg-raised/40 p-3 text-xs leading-5 text-fg/90">
            {item.answerText ?? "—"}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Citations</p>
          <ul className="space-y-1.5">
            {item.citations.map((citation, i) => (
              <li key={citation.chunkId} className="rounded-md border border-border p-2 text-xs">
                <span className="mr-1 font-mono text-accent">[{i + 1}]</span>
                <StatusBadge tone="muted">{citation.docType}</StatusBadge>{" "}
                <span className="font-mono font-semibold">{citation.taskNo || "—"}</span>{" "}
                <span className="font-mono text-[10px] text-muted">
                  p.{citation.page} · {citation.revision}
                </span>
                <div>
                  <Link
                    href={`/manuals?manual=${citation.manualId}&chunk=${citation.chunkId}`}
                    className="text-accent underline-offset-2 hover:underline"
                  >
                    Verify in manual browser →
                  </Link>
                </div>
              </li>
            ))}
            {item.citations.length === 0 ? (
              <li className="text-xs text-muted">No citations.</li>
            ) : null}
          </ul>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button size="sm" onClick={onApprove} disabled={busy} data-testid="approve-button">
          {busy ? "Working…" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setRejecting((v) => !v)}
          disabled={busy}
          data-testid="reject-toggle"
        >
          {rejecting ? "Cancel reject" : "Reject…"}
        </Button>
        {rejecting ? (
          <div className="flex w-full flex-col gap-1 pt-1">
            <Label htmlFor={`note-${item.id}`}>Rejection note (mandatory)</Label>
            <Input
              id={`note-${item.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. cites a superseded revision — re-ask against Rev 38"
            />
            {noteError ? (
              <p role="alert" className="text-xs text-danger">
                {noteError}
              </p>
            ) : null}
            <div>
              <Button
                size="sm"
                variant="danger"
                onClick={submitReject}
                disabled={busy}
                data-testid="reject-button"
              >
                Confirm reject
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}
