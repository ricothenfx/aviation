"use client";

import { useCallback, useEffect, useState } from "react";

import { EmptyState, ErrorState, LiveDot, Skeleton, StatusBadge } from "@aviation/ui";

import { cn } from "@/lib/cn";

/**
 * System readiness panel — the F1 data-bound surface. Implements all four
 * mandatory states (ui-design-system.md §7): loading (skeleton), empty, error
 * (explain + retry), live-updating (LiveDot + poll). Polls the app's /readyz,
 * which itself reports DB, pgvector, model artifact and provider health.
 */

interface ReadinessOk {
  state: "ok";
  status: string;
  dependencies: Record<string, string>;
}
interface ReadinessProblem {
  state: "error";
  message: string;
  requestId?: string;
}
type ReadinessSnapshot = ReadinessOk | ReadinessProblem;

const POLL_MS = 10_000;

const DEPENDENCY_LABELS: Record<string, string> = {
  postgres: "PostgreSQL",
  pgvector: "pgvector",
  provider: "AI provider",
  model: "RUL model",
};

export function ReadinessPanel() {
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/readyz", { cache: "no-store" });
      const body: unknown = await res.json();
      if (!res.ok) {
        const err = body as { error?: { message?: string; requestId?: string } };
        setSnapshot({
          state: "error",
          message: err.error?.message ?? `readiness check failed (${res.status})`,
          requestId: err.error?.requestId,
        });
      } else {
        setSnapshot(body as ReadinessOk);
      }
      setRefreshedAt(Date.now());
    } catch {
      setSnapshot({ state: "error", message: "network error — is the stack running?" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <section
      aria-label="System readiness"
      className="rounded-lg border border-border bg-surface"
      aria-live="polite"
    >
      <header className="flex h-9 items-center justify-between border-b border-border px-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          System readiness
        </h2>
        <LiveDot live={!loading && snapshot?.state === "ok"} label={liveLabel(snapshot)} />
      </header>

      <div className="p-3">
        {loading ? (
          <div className="space-y-2" aria-label="Loading readiness">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : snapshot === null ? (
          <EmptyState
            title="No readiness data yet"
            body="The first readiness poll has not completed. Trigger a manual refresh."
            action={<RetryButton onClick={() => void refresh()} />}
          />
        ) : snapshot.state === "error" ? (
          <ErrorState
            title="Readiness check failed"
            message={snapshot.message}
            requestId={snapshot.requestId}
            action={<RetryButton onClick={() => void refresh()} />}
          />
        ) : (
          <div className="mro-fade-in">
            <ul className="grid gap-2 sm:grid-cols-2">
              {Object.entries(snapshot.dependencies).map(([key, value]) => (
                <li
                  key={key}
                  className="flex items-center justify-between rounded-md border border-border bg-raised/40 px-3 py-2"
                >
                  <span className="text-xs text-muted">{DEPENDENCY_LABELS[key] ?? key}</span>
                  <DependencyBadge value={value} />
                </li>
              ))}
            </ul>
            <p className="mt-2 font-mono text-[10px] text-muted/80">
              polls every {POLL_MS / 1000} s
              {refreshedAt ? ` · last ${new Date(refreshedAt).toISOString().slice(11, 19)}Z` : ""}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function liveLabel(snapshot: ReadinessSnapshot | null): string {
  if (!snapshot) return "connecting";
  return snapshot.state === "ok" ? "live" : "stale";
}

function DependencyBadge({ value }: { value: string }) {
  const tone =
    value === "up" || value === "ready"
      ? "ok"
      : value === "not_loaded" || value === "unconfigured"
        ? "muted"
        : "danger";
  return <StatusBadge tone={tone}>{value}</StatusBadge>;
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg",
        "transition-colors hover:bg-raised",
      )}
    >
      Retry
    </button>
  );
}
