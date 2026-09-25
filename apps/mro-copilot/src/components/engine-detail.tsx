"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  CHART_TOKENS,
  EmptyState,
  ErrorState,
  LiveDot,
  Panel,
  Skeleton,
  StatusBadge,
} from "@aviation/ui";

import { apiEngineDetail } from "@/lib/client/api";
import type { EngineDetail } from "@/lib/api/schemas";

/**
 * Unit detail (PRD F-5): degradation trend — predicted RUL with the ±1.96σ
 * uncertainty band over cycles, plus the unit's maintenance-window threshold
 * line and its alert history. Axes are labeled with units (ui-design-system
 * §8); the time axis is the documented synthetic mapping (1 cycle = 1 day
 * from 2000-01-01, data-model.md §8).
 */

const POLL_MS = 15_000;

interface TrendPoint {
  cycle: number;
  rul: number;
  band: [number, number];
}

export function EngineDetail({ unitId }: { unitId: string }) {
  const [detail, setDetail] = useState<EngineDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; requestId?: string } | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await apiEngineDetail(unitId));
      setError(null);
      setRefreshedAt(Date.now());
    } catch (err) {
      setError({
        message: (err as Error).message,
        requestId: (err as { requestId?: string }).requestId,
      });
    } finally {
      setLoading(false);
    }
  }, [unitId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (loading) {
    return (
      <div className="space-y-4" data-testid="unit-loading">
        <Skeleton className="h-16" />
        <Skeleton className="h-80" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (error && !detail) {
    return (
      <ErrorState
        title={
          error.message.includes("not found") ? "Unknown engine unit" : "Unit data unavailable"
        }
        message={error.message}
        requestId={error.requestId}
        action={
          <Link
            href="/engines"
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-raised"
          >
            ← Back to fleet
          </Link>
        }
      />
    );
  }

  const unit = detail!.unit;
  const trend: TrendPoint[] = detail!.predictions.map((p) => ({
    cycle: p.cycle,
    rul: p.rulCycles,
    band: [p.bandLow, p.bandHigh],
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/engines" className="text-xs text-muted transition-colors hover:text-fg">
          ← Fleet
        </Link>
        <h1 className="font-mono text-lg font-semibold text-fg">{unit.unitId}</h1>
        <StatusBadge tone={unit.dataset === "synthetic-sample" ? "warn" : "info"}>
          {unit.dataset === "synthetic-sample" ? "Synthetic sample" : "C-MAPSS FD001"}
        </StatusBadge>
        <StatusBadge tone={unit.status === "active" ? "ok" : "muted"}>{unit.status}</StatusBadge>
        <span className="font-mono text-xs text-muted">
          window threshold {unit.windowThresholdCycles} cycles · {unit.readingCount} readings ·
          latest cutoff cycle {unit.latestCycle ?? "—"}
        </span>
        <span className="ml-auto">
          <LiveDot live={refreshedAt !== null && !error} label="live" />
        </span>
      </div>

      <Panel
        title={`Predicted RUL trend · ${unit.unitId}`}
        actions={
          <span className="pr-3 font-mono text-[11px] text-muted">uncertainty band ±1.96σ</span>
        }
      >
        {trend.length === 0 ? (
          <EmptyState
            title="No predictions for this unit"
            body={`The unit has ${unit.readingCount} readings of history. Predictions appear once the fleet is scored (engineer+ → Score fleet). Until then its fleet row shows "—", never a placeholder number.`}
          />
        ) : (
          <div className="h-80 w-full" data-testid="trend-chart">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 12, right: 16, bottom: 24, left: 8 }}>
                <XAxis
                  dataKey="cycle"
                  label={{
                    value: "Cycle (synthetic days since 2000-01-01)",
                    position: "insideBottom",
                    offset: -14,
                    fill: CHART_TOKENS.muted,
                    fontSize: 11,
                  }}
                  stroke={CHART_TOKENS.border}
                  tick={{ fill: CHART_TOKENS.muted, fontSize: 11 }}
                  tickLine={false}
                />
                <YAxis
                  label={{
                    value: "Predicted RUL (cycles)",
                    angle: -90,
                    position: "insideLeft",
                    fill: CHART_TOKENS.muted,
                    fontSize: 11,
                  }}
                  stroke={CHART_TOKENS.border}
                  tick={{ fill: CHART_TOKENS.muted, fontSize: 11 }}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "#1A2540",
                    border: `1px solid ${CHART_TOKENS.border}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: CHART_TOKENS.muted }}
                  formatter={(value) => String(value)}
                />
                <ReferenceLine
                  y={unit.windowThresholdCycles}
                  stroke={CHART_TOKENS.danger}
                  strokeDasharray="6 4"
                  label={{
                    value: `Maintenance window (${unit.windowThresholdCycles} cyc)`,
                    position: "insideBottomRight",
                    fill: CHART_TOKENS.danger,
                    fontSize: 11,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="band"
                  name="Uncertainty band"
                  stroke="none"
                  fill={CHART_TOKENS.accent}
                  fillOpacity={0.12}
                />
                <Line
                  type="monotone"
                  dataKey="rul"
                  name="Predicted RUL (cycles)"
                  stroke={CHART_TOKENS.accent}
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      <Panel title="Alert history" contentClassName="px-0 py-0">
        {detail!.alerts.length === 0 ? (
          <EmptyState
            title="No alerts recorded"
            body="This unit has never crossed its maintenance-window threshold at scoring time — or its alerts are resolved (FR-17/FR-18)."
          />
        ) : (
          <ul className="divide-y divide-border/60 text-xs">
            {detail!.alerts.map((alert) => (
              <li key={alert.alertId} className="flex flex-wrap items-center gap-x-4 px-4 py-2.5">
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
                <span className="font-mono tabular-nums text-fg">
                  RUL {alert.projectedRul} · lead {alert.leadCycles} cyc
                </span>
                <span className="font-mono text-[11px] text-muted">
                  {alert.modelVersion} · {alert.modelSha256.slice(0, 10)}…
                </span>
                <span className="font-mono text-[11px] text-muted">
                  raised {new Date(alert.raisedAt).toLocaleString()}
                </span>
                {alert.resolvedByName ? (
                  <span className="text-[11px] text-muted">
                    resolved by {alert.resolvedByName}: “{alert.resolveNote}”
                  </span>
                ) : alert.acknowledgedByName ? (
                  <span className="text-[11px] text-muted">ack by {alert.acknowledgedByName}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <footer className="flex flex-wrap items-center justify-between gap-2 pb-2 text-[11px] text-muted">
        <span data-testid="simulated-data-disclaimer">Simulated data for portfolio purposes</span>
        <span>
          Data: NASA C-MAPSS FD001 — Saxena &amp; Goebel (2008), PHM08 · synthetic time axis: 1
          cycle = 1 day from 2000-01-01
        </span>
      </footer>
    </div>
  );
}
