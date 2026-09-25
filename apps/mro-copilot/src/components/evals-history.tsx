"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  EmptyState,
  ErrorState,
  Panel,
  Skeleton,
  StatTile,
  StatusBadge,
} from "@aviation/ui";

import { ApiClientError, apiGet } from "@/lib/client/api";
import { evalRunsResponseSchema, type EvalRunSummary } from "@/lib/api/schemas";

/**
 * Eval dashboard (PRD F-6, US-7; api-contracts.md §1 GET /evals): read-only
 * run history for reviewers — every gate value traceable to a committed
 * fixture version. Bad runs are reported alongside good ones (data-ethics §4).
 */

export function EvalsHistory() {
  return (
    <Panel
      title="Eval runs · golden-QA & refusal gates (simulated corpus)"
      className="min-h-[70vh]"
    >
      <History />
    </Panel>
  );
}

function History() {
  const [runs, setRuns] = useState<EvalRunSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet("/api/v1/evals", evalRunsResponseSchema.parse);
      setRuns(data.runs);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : "failed to load eval runs",
        requestId: err instanceof ApiClientError ? err.requestId : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <ErrorState
        title="Eval history unavailable"
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
  if (loading && runs === null) {
    return (
      <div className="space-y-2" aria-hidden>
        {[0, 1].map((i) => (
          <div key={i} className="rounded-lg border border-border p-3">
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }
  if (runs !== null && runs.length === 0) {
    return (
      <EmptyState
        title="No eval runs recorded yet"
        body="Eval runs are persisted by the eval CLI (pnpm eval:mro) in CI. Recall, refusal accuracy, citation validity and grounded answer rate appear here once the first full run lands."
      />
    );
  }

  return (
    <div className="space-y-3" data-testid="eval-run-list">
      {(runs ?? []).map((run) => (
        <div key={run.runId} className="rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={run.passed ? "ok" : "danger"}>
              {run.passed ? "passed" : "failed"}
            </StatusBadge>
            <StatusBadge tone="muted">{run.mode}</StatusBadge>
            <span className="font-mono text-[10px] text-muted">
              fixture v{run.fixtureVersion} · {new Date(run.startedAt).toLocaleString("en-GB")}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <GateTile label="Recall@5" value={run.gates.recallAt5} gate="≥ 0.85" />
            <GateTile label="Refusal accuracy" value={run.gates.refusalAccuracy} gate="100%" />
            <GateTile label="Citation validity" value={run.gates.citationValidity} gate="100%" />
            <GateTile label="Grounded rate" value={run.gates.groundedRate} gate="≥ 80%" />
          </div>
        </div>
      ))}
    </div>
  );
}

function GateTile({ label, value, gate }: { label: string; value: number | null; gate: string }) {
  return (
    <StatTile
      label={label}
      value={value === null ? "—" : `${(value * 100).toFixed(1)}%`}
      hint={`gate ${gate}`}
    />
  );
}
