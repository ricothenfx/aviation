"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, ErrorState, Panel, Skeleton, StatusBadge } from "@aviation/ui";

import { ApiClientError, apiIngestRuns, apiTriggerIngest } from "@/lib/client/api";
import type { IngestReport } from "@/lib/ai/contract";
import type { IngestRunSummary } from "@/lib/api/schemas";

/**
 * Corpus ingest console (PRD US-10; api-contracts.md §1 Admin/Ingest).
 * Reviewer+ can trigger an idempotent re-ingest and see run evidence:
 * corpus digest, chunk counts (new/changed/unchanged/removed), embedding
 * model, duration. Re-ingesting an unchanged corpus changes nothing (FR-5) —
 * the panel shows that honestly as all-unchanged counts.
 */

export function IngestPanel() {
  return (
    <Panel title="Corpus ingest · re-ingestion & run evidence (reviewer)" className="min-h-[40vh]">
      <IngestConsole />
    </Panel>
  );
}

function IngestConsole() {
  const [runs, setRuns] = useState<IngestRunSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [result, setResult] = useState<IngestReport | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiIngestRuns();
      setRuns(data.runs);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : "failed to load ingest runs",
        requestId: err instanceof ApiClientError ? err.requestId : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const trigger = useCallback(async () => {
    setTriggering(true);
    setError(null);
    setResult(null);
    try {
      const report = await apiTriggerIngest();
      setResult(report);
      await load();
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : "ingest failed",
        requestId: err instanceof ApiClientError ? err.requestId : undefined,
      });
    } finally {
      setTriggering(false);
    }
  }, [load]);

  if (error) {
    return (
      <div className="space-y-3">
        <ErrorState
          title="Ingest status unavailable"
          message={error.message}
          requestId={error.requestId}
          action={
            <Button size="sm" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
        {runs !== null && <RunTable runs={runs} />}
      </div>
    );
  }
  if (loading && runs === null) {
    return (
      <div className="space-y-2" aria-hidden>
        {[0, 1].map((i) => (
          <div key={i} className="rounded-lg border border-border p-3">
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    );
  }
  if (runs !== null && runs.length === 0) {
    return (
      <EmptyState
        title="No ingest runs recorded yet"
        body="The ai-service records one run per corpus ingestion. Trigger a re-ingest to create the first evidence row (idempotent — an unchanged corpus reports all-unchanged counts)."
        action={
          <Button size="sm" disabled={triggering} onClick={() => void trigger()}>
            {triggering ? "Ingesting…" : "Re-ingest corpus"}
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3" data-testid="ingest-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-xs text-muted">
          Ingestion is idempotent by chunk content hash (FR-5): re-ingesting the unchanged corpus
          reports <span className="font-mono">new 0 · changed 0</span> and reuses stored embeddings.
        </p>
        <Button size="sm" disabled={triggering} onClick={() => void trigger()}>
          {triggering ? "Ingesting…" : "Re-ingest corpus"}
        </Button>
      </div>

      {triggering && (
        <div role="status" className="rounded-lg border border-border p-3">
          <Skeleton className="h-3 w-1/2" />
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-ok/40 bg-surface p-4" data-testid="ingest-result">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="ok">{result.status}</StatusBadge>
            <span className="font-mono text-[10px] text-muted">
              digest {result.corpusDigest.slice(0, 12)}… · {result.durationMs} ms ·{" "}
              {result.embeddingModel}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-4 font-mono text-xs">
            <span>new {result.chunks.new}</span>
            <span>changed {result.chunks.changed}</span>
            <span>unchanged {result.chunks.unchanged}</span>
            <span>removed {result.chunks.removed}</span>
          </div>
        </div>
      )}

      {runs !== null && <RunTable runs={runs} />}
    </div>
  );
}

function RunTable({ runs }: { runs: IngestRunSummary[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-xs">
        <thead className="bg-surface text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Corpus digest</th>
            <th className="px-3 py-2 font-medium">New</th>
            <th className="px-3 py-2 font-medium">Changed</th>
            <th className="px-3 py-2 font-medium">Unchanged</th>
            <th className="px-3 py-2 font-medium">Removed</th>
            <th className="px-3 py-2 font-medium">Duration</th>
            <th className="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runId} className="border-t border-border">
              <td className="whitespace-nowrap px-3 py-2 font-mono text-[10px]">
                {new Date(run.createdAt).toLocaleString("en-GB")}
              </td>
              <td className="px-3 py-2 font-mono text-[10px]">{run.corpusDigest.slice(0, 12)}…</td>
              <td className="px-3 py-2 font-mono">{run.chunksNew}</td>
              <td className="px-3 py-2 font-mono">{run.chunksChanged}</td>
              <td className="px-3 py-2 font-mono">{run.chunksUnchanged}</td>
              <td className="px-3 py-2 font-mono">{run.chunksRemoved}</td>
              <td className="whitespace-nowrap px-3 py-2 font-mono">{run.durationMs} ms</td>
              <td className="px-3 py-2">
                <StatusBadge tone={run.status === "completed" ? "ok" : "danger"}>
                  {run.status}
                </StatusBadge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
