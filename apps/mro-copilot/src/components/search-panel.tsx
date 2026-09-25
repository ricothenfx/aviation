"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LiveDot,
  Panel,
  Skeleton,
  StatusBadge,
} from "@aviation/ui";

import { apiSearch } from "@/lib/client/api";
import { DOC_TYPES, type SearchResponse } from "@/lib/api/schemas";

/**
 * Hybrid search UI (PRD US-2/F-2, ui-design-system.md §7). Surfaces the
 * retrieval mode honestly (FR-7): lexical-only results are flagged as a
 * degraded state, not silently blended in. Snippet [[..]] markers from
 * ts_headline render as highlights.
 */

const DEGRADED_COPY =
  "Embedding provider unavailable — showing lexical-only results (exact term matching). " +
  "Semantic recall is degraded.";

export function SearchPanel() {
  return (
    <Panel title="Search · NX-320 corpus (simulated)" className="min-h-[70vh]">
      <Search />
    </Panel>
  );
}

function Search() {
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [docType, setDocType] = useState<string>("");
  const [ataChapter, setAtaChapter] = useState<string>("");
  const [revision, setRevision] = useState<string>("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [searchedQuery, setSearchedQuery] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback((q: string, dt: string, ac: string, rev: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const params = new URLSearchParams();
    params.set("q", q);
    if (dt) params.set("docType", dt);
    if (ac) params.set("ataChapter", ac);
    if (rev) params.set("revision", rev);
    params.set("limit", "10");
    setLoading(true);
    setError(null);
    apiSearch(params, controller.signal)
      .then((data) => {
        setResult(data);
        setSearchedQuery(q);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError({
          message: err instanceof Error ? err.message : "search failed",
          requestId: (err as { requestId?: string }).requestId,
        });
      })
      .finally(() => setLoading(false));
  }, []);

  // Deep link: /search?q=… runs immediately.
  useEffect(() => {
    const initial = searchParams.get("q");
    if (initial) runSearch(initial, "", "", "");
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (query.trim()) runSearch(query.trim(), docType, ataChapter, revision);
  }

  const showResults = result !== null || loading || error !== null;

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="space-y-3" aria-label="Corpus search">
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. "accumulator torque 34.5" or "fault code FC-29704-514"'
            aria-label="Search query"
            className="h-10 flex-1"
          />
          <Button type="submit" disabled={loading || !query.trim()}>
            {loading ? "Searching…" : "Search"}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div>
            <Label htmlFor="f-doc-type">Doc type</Label>
            <select
              id="f-doc-type"
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-bg px-2 text-sm text-fg focus:border-accent focus:outline-none"
            >
              <option value="">All</option>
              {DOC_TYPES.map((dt) => (
                <option key={dt} value={dt}>
                  {dt}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="f-ata">ATA chapter</Label>
            <Input
              id="f-ata"
              inputMode="numeric"
              value={ataChapter}
              onChange={(e) => setAtaChapter(e.target.value.replace(/\D/g, "").slice(0, 3))}
              placeholder="29"
            />
          </div>
          <div>
            <Label htmlFor="f-revision">Revision (exact)</Label>
            <Input
              id="f-revision"
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
              placeholder="Rev 37"
            />
          </div>
        </div>
      </form>

      {!showResults ? (
        <EmptyState
          title="Search the maintenance library"
          body="Plain-language queries hit hybrid retrieval — pgvector semantic plus lexical matching, fused by reciprocal rank. Results carry doc, task, page and revision."
        />
      ) : error ? (
        <ErrorState
          title="Search failed"
          message={error.message}
          requestId={error.requestId}
          action={
            <Button
              size="sm"
              onClick={() => runSearch(query.trim(), docType, ataChapter, revision)}
            >
              Retry search
            </Button>
          }
        />
      ) : loading ? (
        <div className="space-y-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-2 rounded-lg border border-border p-3">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          ))}
        </div>
      ) : result && result.results.length === 0 ? (
        <EmptyState
          title={`No matches for “${searchedQuery}”`}
          body="Nothing in the corpus matched — try different terminology or clear the filters. The copilot refuses to answer when retrieval cannot ground it."
        />
      ) : result ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {result.mode === "hybrid" ? (
                <StatusBadge tone="info">hybrid retrieval</StatusBadge>
              ) : (
                <StatusBadge tone="warn">lexical-only · degraded</StatusBadge>
              )}
              <span className="font-mono text-[11px] text-muted">
                {result.results.length} results · {result.latencyMs} ms
              </span>
            </div>
            <LiveDot
              live={!loading}
              label={result.mode === "hybrid" ? "retrieval current" : "degraded mode"}
            />
          </div>
          {result.mode === "lexical" ? (
            <p className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs text-warn">
              {DEGRADED_COPY}
            </p>
          ) : null}
          <ul className="space-y-2">
            {result.results.map((hit, index) => (
              <li
                key={hit.chunkId}
                className="rounded-lg border border-border bg-surface p-3 transition-colors hover:border-accent/40"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] text-muted">#{index + 1}</span>
                  <StatusBadge tone="muted">{hit.docType}</StatusBadge>
                  <span className="font-mono text-xs font-semibold text-accent">
                    {hit.taskNo || "—"}
                  </span>
                  <span className="font-mono text-[10px] text-muted">
                    ATA {hit.ataChapter} · p.{hit.page} · {hit.revision} · effective{" "}
                    {hit.effectiveDate}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-muted">
                    score {hit.score.toFixed(4)}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-fg/90">
                  <Snippet text={hit.snippet} />
                </p>
                <p className="mt-2 break-words font-mono text-[10px] text-muted">
                  {hit.sectionPath}
                </p>
                <div className="mt-2">
                  <Link
                    href={`/manuals?manual=${hit.manualId}&chunk=${hit.chunkId}`}
                    className="text-xs font-medium text-accent underline-offset-2 hover:underline"
                  >
                    Open in manual browser →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * ts_headline marks matches with [[...]]; render them as <mark> without
 * dangerouslySetInnerHTML (content stays escaped — ui-design-system §9).
 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[\[|\]\]/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-accent/20 px-0.5 text-accent">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
