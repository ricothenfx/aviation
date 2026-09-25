"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import {
  CHART_TOKENS,
  EmptyState,
  ErrorState,
  LiveDot,
  Panel,
  Skeleton,
  StatTile,
  StatusBadge,
} from "@aviation/ui";

import {
  apiAcknowledgeAlert,
  apiEngines,
  apiEngineAlerts,
  apiEngineModel,
  apiResolveAlert,
  apiScoreFleet,
} from "@/lib/client/api";
import type { EngineModel, EnginesResponse } from "@/lib/api/schemas";
import { cn } from "@/lib/cn";

/**
 * Fleet health dashboard (PRD F-5, ui-design-system §5/§7/§8): KPI tiles →
 * fleet table → maintenance-window alert queue. Implements all four mandatory
 * states (loading skeleton, empty, error + requestId, live poll) and keeps
 * the simulated-data + C-MAPSS citation footer persistent (data-ethics §2).
 */

const POLL_MS = 15_000;

const DATASET_LABEL: Record<string, string> = {
  "cmapss-fd001": "C-MAPSS FD001",
  "synthetic-sample": "Synthetic sample",
};

function formatRul(value: number | null | undefined): string {
  // Honesty case (D-15 precedent): missing data renders "—", never 0.
  return value === null || value === undefined ? "—" : String(value);
}

export function FleetDashboard({ role }: { role: "viewer" | "engineer" | "reviewer" }) {
  const canOperate = role === "engineer" || role === "reviewer";

  const [fleet, setFleet] = useState<EnginesResponse | null>(null);
  const [model, setModel] = useState<EngineModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [scoring, setScoring] = useState(false);
  const [scoreMessage, setScoreMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [fleetResult, modelResult] = await Promise.allSettled([apiEngines(), apiEngineModel()]);
      if (fleetResult.status === "fulfilled") {
        setFleet(fleetResult.value);
        setError(null);
      } else {
        const err = fleetResult.reason as { message?: string; requestId?: string };
        setError({ message: err.message ?? "fleet unavailable", requestId: err.requestId });
      }
      if (modelResult.status === "fulfilled") {
        setModel(modelResult.value);
      } else {
        setModel(null);
      }
      setRefreshedAt(Date.now());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function runScoreFleet() {
    setScoring(true);
    setScoreMessage(null);
    try {
      const result = await apiScoreFleet();
      setScoreMessage(
        `Scored ${result.scored} unit(s) with model ${result.modelVersion}` +
          (result.insufficientHistory.length
            ? ` · ${result.insufficientHistory.length} insufficient history`
            : "") +
          (result.raisedAlerts.length ? ` · ${result.raisedAlerts.length} alert(s) raised` : ""),
      );
      await refresh();
    } catch (err) {
      setScoreMessage((err as Error).message);
    } finally {
      setScoring(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4" data-testid="fleet-loading">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px]" />
          ))}
        </div>
        <Skeleton className="h-24" />
        <Skeleton className="h-72" />
        <Skeleton className="h-56" />
      </div>
    );
  }

  if (error && !fleet) {
    return (
      <ErrorState
        title="Fleet data unavailable"
        message={error.message}
        requestId={error.requestId}
        action={
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void refresh();
            }}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-raised"
          >
            Retry
          </button>
        }
      />
    );
  }

  const units = fleet?.units ?? [];
  if (units.length === 0) {
    return (
      <Panel title="Fleet health · no units" className="min-h-[60vh]">
        <EmptyState
          title="No engine units in the fleet"
          body="The fleet is seeded from the pinned C-MAPSS FD001 download plus the committed synthetic sample. Run `pnpm seed:mro` with the stack up, then rescore."
        />
        <Footer />
      </Panel>
    );
  }

  const scored = units.filter((u) => u.latestRul !== null);
  const atRisk = units.filter(
    (u) => u.latestRul !== null && u.latestRul <= u.windowThresholdCycles,
  );
  const openAlerts = units.reduce((sum, u) => sum + u.alertCount, 0);
  const unscored = units.length - scored.length;

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Fleet units"
          value={String(units.length)}
          hint={`${scored.length} scored`}
        />
        <StatTile
          label="At-risk (RUL ≤ window)"
          value={String(atRisk.length)}
          hint={`threshold ≤ ${Math.min(...units.map((u) => u.windowThresholdCycles))} cycles`}
          className={atRisk.length > 0 ? "border-warn/50" : undefined}
        />
        <StatTile
          label="Open alerts"
          value={String(openAlerts)}
          hint={unscored > 0 ? `${unscored} awaiting history` : "all units scored"}
          className={openAlerts > 0 ? "border-danger/50" : undefined}
        />
        <StatTile
          label="Model"
          value={model ? model.modelVersion : "—"}
          hint={
            model
              ? `RMSE ${model.metrics.rmse.toFixed(1)} cyc · FD001 test`
              : "artifact unavailable"
          }
        />
      </div>

      {/* Provenance strip (FR-16) */}
      <Panel title="Model provenance · ADR-0011 GBM">
        {model ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 font-mono text-xs text-muted">
            <span>
              version <span className="text-fg">{model.modelVersion}</span>
            </span>
            <span title={model.modelSha256}>
              sha256 <span className="text-fg">{model.modelSha256.slice(0, 12)}…</span>
            </span>
            <span>
              trained <span className="text-fg">{model.trainedAt.slice(0, 10)}</span>
            </span>
            <span>
              dataset <span className="text-fg">{model.dataset}</span>
            </span>
            <span>
              NASA score <span className="text-fg">{model.metrics.nasaScore.toFixed(1)}</span>
            </span>
          </div>
        ) : (
          <EmptyState
            title="Model artifact not loaded"
            body="Predictions are refused until the versioned artifact loads (MODEL_NOT_LOADED). Check ai-service /readyz — this is the architecture §6 failure path, surfaced honestly."
          />
        )}
      </Panel>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <LiveDot live={refreshedAt !== null && !error} label={liveLabel(refreshedAt)} />
        <div className="flex items-center gap-2">
          {scoreMessage ? (
            <span className="text-xs text-muted" data-testid="score-message">
              {scoreMessage}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void runScoreFleet()}
            disabled={!canOperate || scoring}
            title={
              canOperate
                ? "Rescore the fleet with the current model"
                : "Requires engineer role — server enforces RBAC"
            }
            className={cn(
              "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors duration-150 ease-out",
              canOperate && !scoring
                ? "border-accent/40 text-accent hover:bg-raised"
                : "cursor-not-allowed border-border text-muted/60",
            )}
          >
            {scoring ? "Scoring…" : "Score fleet"}
          </button>
        </div>
      </div>

      {error ? (
        <ErrorState
          title="Fleet refresh failed"
          message={error.message}
          requestId={error.requestId}
        />
      ) : null}

      {/* Fleet table */}
      <Panel
        title="Fleet · remaining useful life"
        contentClassName="px-0 py-0"
        actions={
          <span className="pr-3 font-mono text-[11px] text-muted">RUL in cycles · band ±1.96σ</span>
        }
      >
        {scored.length === 0 ? (
          <EmptyState
            title="No predictions yet"
            body="Units appear with '—' until the fleet is scored. Run Score fleet (engineer+) to produce the first predictions with full provenance."
          />
        ) : (
          <table className="w-full text-left text-xs" data-testid="fleet-table">
            <thead>
              <tr className="border-b border-border text-muted">
                <th className="px-4 py-2 font-medium">Unit</th>
                <th className="px-4 py-2 font-medium">Latest RUL (cycles)</th>
                <th className="px-4 py-2 font-medium">Band</th>
                <th className="px-4 py-2 font-medium">At cutoff cycle</th>
                <th className="px-4 py-2 font-medium">Window threshold</th>
                <th className="px-4 py-2 font-medium">Model</th>
                <th className="px-4 py-2 font-medium">Alerts</th>
                <th className="px-4 py-2 font-medium">Data</th>
              </tr>
            </thead>
            <tbody>
              {units.map((unit) => {
                const risk =
                  unit.latestRul !== null && unit.latestRul <= unit.windowThresholdCycles;
                return (
                  <tr
                    key={unit.unitId}
                    className="border-b border-border/60 transition-colors hover:bg-raised/40"
                    data-testid="fleet-row"
                  >
                    <td className="px-4 py-2">
                      <Link
                        href={`/engines/${encodeURIComponent(unit.unitId)}`}
                        className="font-mono text-accent hover:underline"
                      >
                        {unit.unitId}
                      </Link>
                      {unit.status === "removed" ? (
                        <span className="ml-2 text-muted">removed</span>
                      ) : null}
                    </td>
                    <td
                      className="px-4 py-2 font-mono tabular-nums"
                      data-testid={`rul-${unit.unitId}`}
                    >
                      <span className={risk ? "text-danger" : "text-fg"}>
                        {formatRul(unit.latestRul)}
                      </span>
                      {unit.latestRul === null ? (
                        <span
                          className="ml-2 text-muted"
                          title="Insufficient history for an honest prediction"
                        >
                          (no history)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 font-mono tabular-nums text-muted">
                      {unit.bandLow === null || unit.bandHigh === null
                        ? "—"
                        : `${unit.bandLow}…${unit.bandHigh}`}
                    </td>
                    <td className="px-4 py-2 font-mono tabular-nums text-muted">
                      {formatRul(unit.latestCycle)}
                    </td>
                    <td className="px-4 py-2 font-mono tabular-nums text-muted">
                      {unit.windowThresholdCycles}
                    </td>
                    <td className="px-4 py-2 font-mono text-muted">{unit.modelVersion ?? "—"}</td>
                    <td className="px-4 py-2">
                      {unit.alertCount > 0 ? (
                        <StatusBadge tone="danger">{`${unit.alertCount} open`}</StatusBadge>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge tone={unit.dataset === "synthetic-sample" ? "warn" : "info"}>
                        {DATASET_LABEL[unit.dataset] ?? unit.dataset}
                      </StatusBadge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <AlertsPanel canOperate={canOperate} onChanged={refresh} />

      <Footer />
    </div>
  );
}

function liveLabel(refreshedAt: number | null): string {
  if (refreshedAt === null) return "connecting…";
  return `live · refreshed ${new Date(refreshedAt).toLocaleTimeString()}`;
}

function AlertsPanel({
  canOperate,
  onChanged,
}: {
  canOperate: boolean;
  onChanged: () => Promise<void>;
}) {
  const [alerts, setAlerts] = useState<Awaited<ReturnType<typeof loadAlerts>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAlerts(await loadAlerts());
    } catch {
      setAlerts(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function act(fn: () => Promise<unknown>, id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await fn();
      await onChanged();
      await load();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <Skeleton className="h-40" />;

  const items = alerts?.alerts ?? [];
  const open = items.filter((a) => a.state !== "resolved");

  return (
    <Panel
      title="Maintenance-window alerts"
      contentClassName="px-0 py-0"
      actions={
        <span className="pr-3 font-mono text-[11px] text-muted">
          raised → acknowledged → resolved
        </span>
      }
    >
      {open.length === 0 ? (
        <EmptyState
          title="No open alerts"
          body="Alerts appear when a unit's predicted RUL crosses its maintenance-window threshold (≥ 5 cycles lead in fixtures, FR-18)."
        />
      ) : (
        <ul className="divide-y divide-border/60">
          {items.map((alert) => (
            <li
              key={alert.alertId}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
              data-testid="alert-item"
            >
              <StatusBadge
                tone={
                  alert.state === "raised"
                    ? "danger"
                    : alert.state === "acknowledged"
                      ? "warn"
                      : "ok"
                }
              >
                {alert.state}
              </StatusBadge>
              <Link
                href={`/engines/${encodeURIComponent(alert.unitId)}`}
                className="font-mono text-accent hover:underline"
              >
                {alert.unitId}
              </Link>
              <span className="font-mono tabular-nums text-fg">
                RUL {alert.projectedRul} ≤ window {alert.threshold}
              </span>
              <span
                className="font-mono tabular-nums text-muted"
                title="Lead time before projected removal"
              >
                lead {alert.leadCycles} cyc
              </span>
              <span className="font-mono text-[11px] text-muted">
                {alert.modelVersion} · {alert.modelSha256.slice(0, 10)}…
              </span>
              <span className="font-mono text-[11px] text-muted">
                raised {new Date(alert.raisedAt).toLocaleString()}
              </span>
              {alert.acknowledgedByName ? (
                <span className="text-[11px] text-muted">ack by {alert.acknowledgedByName}</span>
              ) : null}
              {alert.state === "resolved" && alert.resolvedByName ? (
                <span className="text-[11px] text-muted">
                  resolved by {alert.resolvedByName}: “{alert.resolveNote}”
                </span>
              ) : null}

              <span className="ml-auto flex items-center gap-2">
                {resolving === alert.alertId ? (
                  <>
                    <input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Resolution note (required)"
                      aria-label="Resolution note"
                      className="w-56 rounded-md border border-border bg-raised px-2 py-1 text-xs text-fg placeholder:text-muted/60 focus:border-accent focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={note.trim().length < 3 || busyId !== null}
                      onClick={() => {
                        void act(() => apiResolveAlert(alert.alertId, note.trim()), alert.alertId);
                        setResolving(null);
                        setNote("");
                      }}
                      className="rounded-md border border-ok/40 px-2 py-1 text-xs text-ok disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Confirm resolve
                    </button>
                    <button
                      type="button"
                      onClick={() => setResolving(null)}
                      className="text-xs text-muted hover:text-fg"
                    >
                      Cancel
                    </button>
                  </>
                ) : alert.state === "raised" ? (
                  <button
                    type="button"
                    disabled={!canOperate || busyId !== null}
                    title={canOperate ? "" : "Requires engineer role"}
                    onClick={() =>
                      void act(() => apiAcknowledgeAlert(alert.alertId), alert.alertId)
                    }
                    className="rounded-md border border-warn/40 px-2 py-1 text-xs text-warn transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
                    data-testid={`ack-${alert.unitId}`}
                  >
                    Acknowledge
                  </button>
                ) : alert.state === "acknowledged" ? (
                  <button
                    type="button"
                    disabled={!canOperate || busyId !== null}
                    title={canOperate ? "" : "Requires engineer role"}
                    onClick={() => {
                      setNote("");
                      setResolving(alert.alertId);
                    }}
                    className="rounded-md border border-ok/40 px-2 py-1 text-xs text-ok transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
                    data-testid={`resolve-${alert.unitId}`}
                  >
                    Resolve…
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {actionError ? (
        <p role="alert" className="px-4 pb-3 text-xs text-danger">
          {actionError}
        </p>
      ) : null}
    </Panel>
  );
}

async function loadAlerts() {
  return apiEngineAlerts(null);
}

function Footer() {
  // The app shell renders the persistent simulated-data Disclaimer
  // (data-ethics §2); C-MAPSS views ADD the dataset citation (FR-3).
  return (
    <footer className="flex flex-wrap items-center justify-between gap-2 pb-2 text-[11px] text-muted">
      <span>
        Data: NASA C-MAPSS FD001 — Saxena &amp; Goebel (2008), PHM08 · fleet identities fictional
        (NX-E)
      </span>
      <span className="font-mono" style={{ color: CHART_TOKENS.muted }}>
        synthetic time axis: 1 cycle = 1 day from 2000-01-01
      </span>
    </footer>
  );
}
