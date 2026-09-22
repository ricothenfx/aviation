"use client";

import { useCallback, useEffect, useState } from "react";

import {
  scenarioListResponseSchema,
  scenarioStartRequestSchema,
  type ScenarioListResponse,
} from "@aviation/contracts";
import { Button, StatusBadge } from "@aviation/ui";

/**
 * Scenario control (PRD F-5 slice, api-contracts.md §1 Scenarios): start/stop the
 * reference day and switch speed. Supervisor-only server-side; the panel renders
 * only for supervisors (console UI polish is F4 — this is the working backend
 * wiring surface).
 */

const SPEEDS = [1, 5, 20] as const;

export function ScenarioPanel({ onChanged }: { onChanged: () => void }) {
  const [scenarios, setScenarios] = useState<ScenarioListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/scenarios");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setScenarios(scenarioListResponseSchema.parse(await res.json()));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load scenarios");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (path: "start" | "reset", body?: unknown) => {
      const scenario = scenarios?.scenarios[0];
      if (!scenario) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/v1/scenarios/${scenario.id}/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(errBody?.error?.message ?? `HTTP ${res.status}`);
        }
        await load();
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : "scenario command failed");
      } finally {
        setBusy(false);
      }
    },
    [scenarios, load, onChanged],
  );

  const scenario = scenarios?.scenarios[0] ?? null;

  return (
    <div aria-label="Scenario control" className="space-y-2 text-xs">
      {error ? <p className="text-danger">{error}</p> : null}
      {scenario === null ? (
        <p className="text-muted">Loading scenario…</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="font-mono text-fg">{scenario.title}</span>
            <StatusBadge tone={scenario.state.status === "running" ? "info" : "muted"}>
              {scenario.state.status}
            </StatusBadge>
          </div>
          <p className="text-muted">
            Scenario clock:{" "}
            {scenario.state.scenarioNow ? `${scenario.state.scenarioNow.slice(11, 19)}Z` : "idle"} ·
            speed ×{scenario.state.speed}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {SPEEDS.map((speed) => (
              <Button
                key={speed}
                size="sm"
                variant={scenario.state.speed === speed ? "primary" : "ghost"}
                disabled={busy}
                onClick={() => void act("start", scenarioStartRequestSchema.parse({ speed }))}
              >
                ×{speed}
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("reset")}>
              Reset
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
