"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, EmptyState, ErrorState, Panel, Skeleton, StatusBadge } from "@aviation/ui";

import { ApiClientError, apiGet } from "@/lib/client/api";
import {
  manualsResponseSchema,
  type ChunkDetailResponse,
  type ManualsResponse,
  type ManualDetail,
} from "@/lib/api/schemas";

/**
 * Manual library browser (PRD US-1/F-1, ui-design-system.md §7). TOC
 * navigation by doc type and ATA chapter; every chunk view carries its
 * breadcrumb, fictional page, revision and effective date (FR-6). Implements
 * loading / empty / error / fresh states; deep-linkable via
 * /manuals?manual=<id>&chunk=<chunkId>.
 */

const EMPTY_COPY =
  "No manuals are ingested yet. The committed NX-320 corpus is ingested by the " +
  "ai-service on stack startup (python -m mro_ai.ingest) — re-run it, then reload.";

export function ManualsBrowser() {
  return (
    <Panel title="Manual library · NX-320 fleet documentation (simulated)" className="min-h-[70vh]">
      <Browser />
    </Panel>
  );
}

function Browser() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const manualParam = searchParams.get("manual");
  const chunkParam = searchParams.get("chunk");

  const [list, setList] = useState<ManualsResponse | null>(null);
  const [listError, setListError] = useState<ApiClientError | null>(null);
  const [selectedManualId, setSelectedManualId] = useState<string | null>(manualParam);
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(chunkParam);

  const loadList = useCallback((signal: AbortSignal) => {
    setListError(null);
    return apiGet("/api/v1/manuals", manualsResponseSchema.parse, signal)
      .then((data) => {
        setList(data);
        return data;
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return null;
        setListError(
          err instanceof ApiClientError
            ? err
            : new ApiClientError("INTERNAL", "unexpected error", 0),
        );
        return null;
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadList(controller.signal).then((data) => {
      if (!data) return;
      if (!selectedManualId && data.manuals.length > 0) {
        setSelectedManualId(data.manuals[0]!.id);
      }
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function navigate(manualId: string, chunkId: string | null) {
    setSelectedManualId(manualId);
    setSelectedChunkId(chunkId);
    const params = new URLSearchParams();
    params.set("manual", manualId);
    if (chunkId) params.set("chunk", chunkId);
    router.replace(`/manuals?${params.toString()}`, { scroll: false });
  }

  if (listError) {
    return (
      <ErrorState
        title="Manual library unavailable"
        message={listError.message}
        requestId={listError.requestId}
        action={
          <Button size="sm" onClick={() => void loadList(new AbortController().signal)}>
            Retry
          </Button>
        }
      />
    );
  }

  if (!list) {
    return <BrowserSkeleton />;
  }

  if (list.manuals.length === 0) {
    return <EmptyState title="Library is empty" body={EMPTY_COPY} />;
  }

  const activeManual = list.manuals.find((m) => m.id === selectedManualId) ?? null;

  return (
    <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="min-h-0 space-y-4">
        <TocPanel list={list} selectedManualId={selectedManualId} onSelect={navigate} />
      </aside>
      <section className="min-h-0">
        {activeManual ? (
          <ManualReader
            manualId={activeManual.id}
            chunkId={selectedChunkId}
            onNavigate={navigate}
          />
        ) : (
          <EmptyState
            title="Select a manual"
            body="Pick a document from the library tree to read its task card or parts list."
          />
        )}
      </section>
    </div>
  );
}

function TocPanel({
  list,
  selectedManualId,
  onSelect,
}: {
  list: ManualsResponse;
  selectedManualId: string | null;
  onSelect: (manualId: string, chunkId: string | null) => void;
}) {
  const manualsByChapter = useMemo(() => {
    const map = new Map<string, ManualsResponse["manuals"]>();
    for (const manual of list.manuals) {
      const key = `${manual.docType}/${manual.ataChapter}`;
      const bucket = map.get(key) ?? [];
      bucket.push(manual);
      map.set(key, bucket);
    }
    return map;
  }, [list]);

  return (
    <Panel title="Library tree">
      <nav aria-label="Manual library" className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
        {list.toc.map((entry) => (
          <div key={entry.docType}>
            <div className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-accent">
              {entry.docType}
            </div>
            <ul className="space-y-2">
              {entry.chapters.map((chapter) => {
                const manuals = manualsByChapter.get(`${entry.docType}/${chapter.chapter}`) ?? [];
                return (
                  <li key={chapter.chapter}>
                    <div className="flex items-center justify-between text-xs text-muted">
                      <span>ATA {chapter.chapter}</span>
                      <span className="font-mono text-[10px]">{chapter.count} docs</span>
                    </div>
                    <ul className="mt-1 space-y-0.5 border-l border-border pl-2">
                      {manuals.map((manual) => (
                        <li key={manual.id}>
                          <button
                            type="button"
                            onClick={() => onSelect(manual.id, null)}
                            className={
                              "w-full truncate rounded px-1.5 py-1 text-left text-xs transition-colors " +
                              (manual.id === selectedManualId
                                ? "bg-raised text-accent"
                                : "text-fg/90 hover:bg-raised/60")
                            }
                            title={manual.title}
                          >
                            {manual.taskNo ?? manual.id.slice(0, 8)} · {manual.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </Panel>
  );
}

function ManualReader({
  manualId,
  chunkId,
  onNavigate,
}: {
  manualId: string;
  chunkId: string | null;
  onNavigate: (manualId: string, chunkId: string | null) => void;
}) {
  const [detail, setDetail] = useState<ManualDetail | null>(null);
  const [detailError, setDetailError] = useState<ApiClientError | null>(null);
  const [chunk, setChunk] = useState<ChunkDetailResponse | null>(null);
  const [chunkError, setChunkError] = useState<ApiClientError | null>(null);
  const [chunkLoading, setChunkLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setDetailError(null);
    apiGet(`/api/v1/manuals/${manualId}`, (raw) => raw as ManualDetail, controller.signal)
      .then((data) => {
        setDetail(data);
        if (!chunkId && data.sections[0]) {
          onNavigate(manualId, data.sections[0].firstChunkId);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setDetailError(
          err instanceof ApiClientError
            ? err
            : new ApiClientError("INTERNAL", "unexpected error", 0),
        );
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualId]);

  useEffect(() => {
    if (!chunkId) {
      setChunk(null);
      return;
    }
    const controller = new AbortController();
    setChunkLoading(true);
    setChunkError(null);
    apiGet(
      `/api/v1/manuals/${manualId}/chunks/${chunkId}`,
      (raw) => raw as ChunkDetailResponse,
      controller.signal,
    )
      .then(setChunk)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setChunkError(
          err instanceof ApiClientError
            ? err
            : new ApiClientError("INTERNAL", "unexpected error", 0),
        );
      })
      .finally(() => setChunkLoading(false));
    return () => controller.abort();
  }, [manualId, chunkId]);

  if (detailError) {
    return (
      <ErrorState
        title="Manual unavailable"
        message={detailError.message}
        requestId={detailError.requestId}
        action={
          <Button size="sm" onClick={() => onNavigate(manualId, null)}>
            Reload manual
          </Button>
        }
      />
    );
  }

  if (!detail) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const manual = detail.manual;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-raised/30 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="info">{manual.docType}</StatusBadge>
          {manual.status === "superseded" ? (
            <StatusBadge tone="warn">{`superseded · ${manual.revision}`}</StatusBadge>
          ) : (
            <StatusBadge tone="ok">{manual.revision}</StatusBadge>
          )}
          <span className="font-mono text-[11px] text-muted">
            effective {manual.effectiveDate} · {detail.chunkCount} chunks
          </span>
        </div>
        <h1 className="mt-2 text-sm font-semibold text-fg">{manual.title}</h1>
        <p className="mt-1 break-words font-mono text-[11px] text-muted">{detail.breadcrumb}</p>
      </div>

      <div className="grid min-h-0 grid-cols-1 gap-3 xl:grid-cols-[240px_minmax(0,1fr)]">
        <Panel title="Sections" contentClassName="max-h-[46vh] overflow-y-auto">
          <ul className="space-y-0.5">
            {detail.sections.map((section) => {
              const active = chunk?.chunk.sectionPath === section.path;
              return (
                <li key={section.path}>
                  <button
                    type="button"
                    onClick={() => onNavigate(manualId, section.firstChunkId)}
                    className={
                      "flex w-full items-baseline justify-between gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors " +
                      (active ? "bg-raised text-accent" : "text-fg/90 hover:bg-raised/60")
                    }
                    style={{ paddingLeft: `${(section.depth - 1) * 10 + 6}px` }}
                    title={section.label}
                  >
                    <span className="truncate">{section.label}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted">
                      p.{section.page}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>

        <Panel
          title="Content"
          actions={
            chunk ? (
              <span className="font-mono text-[10px] text-muted">
                chunk {chunk.chunk.chunkIndex + 1} · page {chunk.chunk.page} ·{" "}
                {chunk.chunk.revision}
              </span>
            ) : null
          }
          contentClassName="max-h-[46vh] overflow-y-auto"
        >
          {chunkError ? (
            <ErrorState
              title="Chunk unavailable"
              message={chunkError.message}
              requestId={chunkError.requestId}
              action={
                <Button size="sm" onClick={() => onNavigate(manualId, chunkId)}>
                  Retry
                </Button>
              }
            />
          ) : chunkLoading || !chunk ? (
            <div className="space-y-2">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
            </div>
          ) : (
            <article>
              <p className="break-words border-b border-border pb-2 font-mono text-[11px] font-semibold text-accent">
                {chunk.chunk.sectionPath}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-fg/90">
                {stripBreadcrumb(chunk.chunk.content, chunk.chunk.sectionPath)}
              </p>
              <div className="mt-4 flex items-center justify-between border-t border-border pt-2">
                <span className="font-mono text-[10px] text-muted">
                  {chunk.chunk.docType} · {chunk.chunk.taskNo ?? "—"} · ATA {chunk.chunk.ataChapter}{" "}
                  · effective {chunk.chunk.effectiveDate}
                </span>
                <span className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!chunk.navigation.prevChunkId}
                    onClick={() =>
                      chunk.navigation.prevChunkId &&
                      onNavigate(manualId, chunk.navigation.prevChunkId)
                    }
                  >
                    ← Prev
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!chunk.navigation.nextChunkId}
                    onClick={() =>
                      chunk.navigation.nextChunkId &&
                      onNavigate(manualId, chunk.navigation.nextChunkId)
                    }
                  >
                    Next →
                  </Button>
                </span>
              </div>
            </article>
          )}
        </Panel>
      </div>
    </div>
  );
}

/** The section path line is rendered separately — strip it from the body. */
function stripBreadcrumb(content: string, sectionPath: string): string {
  return content.startsWith(sectionPath) ? content.slice(sectionPath.length).trimStart() : content;
}

function BrowserSkeleton() {
  return (
    <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <div className="space-y-2">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/6" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
