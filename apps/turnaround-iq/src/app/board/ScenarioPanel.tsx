"use client";

import { useCallback, useEffect, useState } from "react";

import {
  scenarioListResponseSchema,
  scenarioStartRequestSchema,
  type DisruptionSummary,
  type ScenarioSummary,
} from "@aviation/contracts";
import { Button, EmptyState, Skeleton, StatusBadge } from "@aviation/ui";

/**
 * Scenario console (PRD F-5, ui-design-system.md §5.3, api-contracts.md §1
 * Scenarios): reference-day start/speed/reset + scripted disruption injection.
 * Supervisor-only server-side (PRD F-7); the panel renders only for
 * supervisors. All mandatory states (§7): loading skeleton, empty, error+retry,
 * live clock/status from the scenario state mirror.
 */

const SPEEDS = [1, 5, 20] as const;

interface InjectOutcome {
  disruptionId: string;
  status: string;
  flightNo: string | null;
}

export function ScenarioPanel({ onChanged }: { onChanged: () => void }) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[] | null>(null);
  const [disruptions, setDisruptions] = useState<DisruptionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<InjectOutcome | null>(null);
  const [injectError, setInjectError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/v1/scenarios");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = scenarioListResponseSchema.parse(await res.json());
      setScenarios(parsed.scenarios);
      setDisruptions(parsed.disruptions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load scenarios");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const command = useCallback(
    async (path: "start" | "reset", body?: unknown): Promise<boolean> => {
      const scenario = scenarios?.[0];
      if (!scenario) return false;
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
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "scenario command failed");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [scenarios, load, onChanged],
  );

  async function inject(disruption: DisruptionSummary) {
    const scenario = scenarios?.[0];
    if (!scenario) return;
    setBusy(true);
    setOutcome(null);
    setInjectError(null);
    try {
      const res = await fetch(`/api/v1/scenarios/${scenario.id}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disruptionId: disruption.id }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const err =
          body && typeof body === "object" && "error" in body
            ? (body as { error: { message: string } }).error
            : null;
        setInjectError(err?.message ?? `inject failed (HTTP ${res.status})`);
        return;
      }
      setOutcome(
        (body as { disruptionId: string; status: string; flightNo: string | null }) ?? null,
      );
      onChanged();
    } catch {
      setInjectError("inject request failed");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div aria-label="Scenario control" className="space-y-2 text-xs">
        <p role="alert" className="text-danger">
          Scenario control unavailable: {error}
        </p>
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (scenarios === null) {
    return (
      <div aria-label="Scenario control" className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-7 w-full max-w-sm" />
      </div>
    );
  }

  const scenario = scenarios[0] ?? null;

  if (scenario === null) {
    return (
      <div aria-label="Scenario control" className="text-xs">
        <EmptyState
          title="No scenarios registered"
          body="The simulator publishes its scripted scenarios on boot — check the simulator service and retry."
        />
      </div>
    );
  }

  return (
    <div aria-label="Scenario control" className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-fg">{scenario.title}</span>
        <StatusBadge tone={scenario.state.status === "running" ? "info" : "muted"}>
          {scenario.state.status}
        </StatusBadge>
        <span className="text-muted">
          Scenario clock:{" "}
          <span className="font-mono tabular-nums text-fg">
            {scenario.state.scenarioNow ? `${scenario.state.scenarioNow.slice(11, 19)}Z` : "idle"}
          </span>{" "}
          · speed ×{scenario.state.speed}
          {scenario.state.logHash ? (
            <>
              {" "}
              · log <span className="font-mono">{scenario.state.logHash.slice(0, 12)}…</span>
            </>
          ) : null}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted">Speed</span>
        {SPEEDS.map((speed) => (
          <Button
            key={speed}
            size="sm"
            variant={scenario.state.speed === speed ? "primary" : "ghost"}
            disabled={busy}
            aria-pressed={scenario.state.speed === speed}
            onClick={() => void command("start", scenarioStartRequestSchema.parse({ speed }))}
          >
            ×{speed}
          </Button>
        ))}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void command("reset")}>
          Reset
        </Button>
      </div>

      {disruptions.length > 0 ? (
        <div className="space-y-1.5 pt-1">
          <span className="text-muted">Inject disruption</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {disruptions.map((disruption) => (
              <Button
                key={disruption.id}
                size="sm"
                variant="danger"
                disabled={busy}
                title={`${disruption.description} (hits: ${disruption.targetTaskType})`}
                onClick={() => void inject(disruption)}
              >
                {disruption.title}
              </Button>
            ))}
          </div>
          {injectError ? (
            <p role="alert" className="text-danger">
              {injectError}
            </p>
          ) : null}
          {outcome ? (
            <p role="status" className="text-muted">
              Injected <span className="font-mono text-fg">{outcome.disruptionId}</span>
              {outcome.flightNo ? (
                <>
                  {" "}
                  → <span className="font-mono text-fg">{outcome.flightNo}</span>
                </>
              ) : null}{" "}
              · watch the alerts rail
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
