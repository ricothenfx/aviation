"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  LiveDot,
  Panel,
  Skeleton,
  StatusBadge,
} from "@aviation/ui";

import { ApiClientError, apiPost } from "@/lib/client/api";
import { askResponseSchema, type AskResponse, type Citation } from "@/lib/api/schemas";

/**
 * Copilot ask panel (PRD US-3..US-5, F-3; ui-design-system §7 states). The
 * refusal is a first-class result — rendered as an explicit, honest outcome
 * with its machine-readable reason — never an error. Source labeling is
 * contract (FR-12): llm answers disclose the provider, extractive fallbacks
 * are flagged as degraded.
 */

const EXAMPLES = [
  "What torque applies to the cabin pressure outflow valve attach bolts?",
  "How do I clear fault code FC-29704-514?",
];

export function AskPanel() {
  return (
    <Panel title="Copilot · ask the NX-320 library (simulated)" className="min-h-[70vh]">
      <Ask />
    </Panel>
  );
}

function Ask() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function runAsk(q: string) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = await apiPost("/api/v1/ask", { question: q }, askResponseSchema.parse);
      setResult(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError({
        message: err instanceof Error ? err.message : "ask failed",
        requestId: err instanceof ApiClientError ? err.requestId : undefined,
      });
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const q = question.trim();
    if (q.length >= 5) void runAsk(q);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="space-y-2" aria-label="Ask the copilot">
        <div className="flex gap-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. What torque applies to the accumulator attach bolts?"
            aria-label="Maintenance question"
            className="h-10 flex-1"
          />
          <Button type="submit" disabled={loading || question.trim().length < 5}>
            {loading ? "Asking…" : "Ask"}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setQuestion(example);
                void runAsk(example);
              }}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-accent/40 hover:text-fg"
            >
              {example}
            </button>
          ))}
        </div>
      </form>

      {!result && !loading && !error ? (
        <EmptyState
          title="Grounded answers, or an honest refusal"
          body="The copilot answers only from retrieved manual chunks, cites every claim, and refuses explicitly when the corpus cannot ground the question. Drafts go to reviewer sign-off before they are trusted."
        />
      ) : error ? (
        <ErrorState
          title="Ask failed"
          message={error.message}
          requestId={error.requestId}
          action={
            <Button size="sm" onClick={() => void runAsk(question.trim())}>
              Retry
            </Button>
          }
        />
      ) : loading ? (
        <div className="space-y-3" aria-hidden>
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-4/5" />
        </div>
      ) : result ? (
        result.status === "refused" ? (
          <RefusalCard result={result} />
        ) : (
          <DraftCard result={result} />
        )
      ) : null}
    </div>
  );
}

function RefusalCard({ result }: { result: AskResponse }) {
  const reasonCopy =
    result.refusalReason === "below_grounding_threshold"
      ? "Retrieval did not find corpus content grounded enough for this question."
      : "The drafted answer could not cite a single retrieved chunk, so it was discarded.";
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-warn/40 bg-warn/5 p-4"
      data-testid="refusal-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="warn">refused</StatusBadge>
        <span className="font-mono text-[10px] text-muted">{result.refusalReason}</span>
        <span className="ml-auto font-mono text-[10px] text-muted">
          grounding {result.groundingScore.toFixed(3)} · {result.retrieval.mode} ·{" "}
          {result.retrieval.latencyMs} ms
        </span>
      </div>
      <p className="text-sm font-medium text-fg">
        The corpus cannot ground this answer — the copilot refuses instead of guessing.
      </p>
      <p className="text-xs text-muted">{reasonCopy}</p>
      <p className="text-xs text-muted">
        No answer or citations were produced. Try{" "}
        <Link href="/search" className="text-accent underline-offset-2 hover:underline">
          corpus search
        </Link>{" "}
        to find the relevant task cards yourself.
      </p>
    </div>
  );
}

function DraftCard({ result }: { result: AskResponse }) {
  return (
    <div
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      data-testid="draft-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="muted">draft · awaiting reviewer sign-off</StatusBadge>
        {result.source === "llm" ? (
          <StatusBadge tone="info">{`source: llm · provider ${result.provider}`}</StatusBadge>
        ) : (
          <StatusBadge tone="warn">source: extractive fallback</StatusBadge>
        )}
        {result.retrieval.mode === "lexical" ? (
          <StatusBadge tone="warn">lexical-only · degraded</StatusBadge>
        ) : (
          <StatusBadge tone="muted">hybrid retrieval</StatusBadge>
        )}
        <LiveDot live label="fresh answer" />
        <span className="ml-auto font-mono text-[10px] text-muted">
          grounding {result.groundingScore.toFixed(3)} · {result.retrieval.latencyMs} ms
        </span>
      </div>

      {result.source === "extractive" ? (
        <p className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
          LLM provider unavailable — showing the top retrieved chunks verbatim instead of a
          synthesized answer (honest degrade, ADR-0003).
        </p>
      ) : null}

      <CitedAnswer text={result.answer ?? ""} citations={result.citations ?? []} />

      <div className="space-y-1.5 border-t border-border pt-3" data-testid="citation-list">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Citations</p>
        <ul className="space-y-1.5">
          {(result.citations ?? []).map((citation, i) => (
            <li key={citation.chunkId} id={`cite-${i + 1}`} className="text-xs leading-5">
              <span className="mr-1.5 font-mono text-accent">[{i + 1}]</span>
              <StatusBadge tone="muted">{citation.docType}</StatusBadge>{" "}
              <span className="font-mono font-semibold">{citation.taskNo || "—"}</span>{" "}
              <span className="font-mono text-[10px] text-muted">
                ATA {citation.ataChapter} · p.{citation.page} · {citation.revision}
              </span>
              <div className="mt-0.5">
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
    </div>
  );
}

/** Renders answer text with [n] markers as citation superscripts (no raw HTML). */
function CitedAnswer({ text, citations }: { text: string; citations: Citation[] }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <p className="whitespace-pre-line text-sm leading-6 text-fg/90">
      {parts.map((part, i) => {
        const marker = part.match(/^\[(\d+)\]$/);
        if (!marker) return <span key={i}>{part}</span>;
        const n = Number(marker[1]);
        if (n < 1 || n > citations.length) return <span key={i}>{part}</span>;
        return (
          <a
            key={i}
            href={`#cite-${n}`}
            className="mx-0.5 align-super font-mono text-[10px] text-accent hover:underline"
            title={citations[n - 1]!.sectionPath}
          >
            [{n}]
          </a>
        );
      })}
    </p>
  );
}
