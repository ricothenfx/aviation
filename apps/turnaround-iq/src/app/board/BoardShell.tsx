"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Button,
  EmptyState,
  ErrorState,
  LiveDot,
  Panel,
  Skeleton,
  StatTile,
  StatusBadge,
} from "@aviation/ui";
import { boardSnapshotSchema, type BoardSnapshot } from "@aviation/contracts";

type FetchStatus = "loading" | "success" | "error";

/**
 * Command board shell (ui-design-system.md §5 archetype 1) implementing the four
 * mandatory states (§7): loading skeleton, empty, error+retry, live-updating cue.
 *
 * F1 honesty: the scenario engine, projections and WebSocket land in F2, so the data
 * area renders structured empty states and the KPI tiles show "—". `?state=` forces a
 * state for scaffold review; it is removed once real data flows (F2).
 */
export function BoardShell({ user }: { user: { displayName: string; role: string } }) {
  const router = useRouter();
  const [status, setStatus] = useState<FetchStatus>("loading");
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reloadToken, setReloadToken] = useState(0);

  const forcedState = useForcedState();

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const res = await fetch("/api/v1/board", { headers: { Accept: "application/json" } });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const err =
          body && typeof body === "object" && "error" in body
            ? (body as { error: { code?: string; requestId?: string } }).error
            : undefined;
        setErrorCode(err?.code ?? `HTTP_${res.status}`);
        setRequestId(err?.requestId ?? null);
        setStatus("error");
        return;
      }
      const parsed = boardSnapshotSchema.safeParse(await res.json());
      if (!parsed.success) {
        setErrorCode("CONTRACT_VIOLATION");
        setRequestId(null);
        setStatus("error");
        return;
      }
      setSnapshot(parsed.data);
      setUpdatedAt(new Date());
      setStatus("success");
    } catch {
      setErrorCode("NETWORK");
      setRequestId(null);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const secondsAgo = useMemo(
    () => (updatedAt ? Math.max(0, Math.floor((now - updatedAt.getTime()) / 1000)) : null),
    [now, updatedAt],
  );

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => null);
    router.replace("/login");
    router.refresh();
  }

  const view =
    forcedState ??
    (status === "loading"
      ? "loading"
      : status === "error"
        ? "error"
        : snapshot && snapshot.flights.length === 0
          ? "empty"
          : "live");

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-2rem)] w-full max-w-7xl flex-col gap-3 px-4 py-3">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-accent/40 bg-raised font-mono text-xs font-bold text-accent">
            TIQ
          </div>
          <div>
            <h1 className="text-sm font-semibold text-fg">Turnaround Command Board</h1>
            <p className="text-xs text-muted">Synthetic airport · reference day</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">{user.displayName}</span>
          <StatusBadge
            tone={
              user.role === "supervisor" ? "warn" : user.role === "coordinator" ? "info" : "muted"
            }
          >
            {user.role}
          </StatusBadge>
          <Button variant="ghost" size="sm" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>

      {/* KPI strip (PRD F-6) — live freshness cue per ui-design-system.md §7 */}
      <section aria-label="Operations KPIs" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {view === "loading" ? (
          <>
            <Skeleton className="h-[76px]" />
            <Skeleton className="h-[76px]" />
            <Skeleton className="h-[76px]" />
            <Skeleton className="h-[76px]" />
          </>
        ) : (
          <>
            <StatTile label="On-time departures" value="—" hint="arrives with F2 projections" />
            <StatTile label="Avg turn time" value="—" hint="arrives with F2 projections" />
            <StatTile label="Active alerts" value="—" hint="arrives with F3 risk rules" />
            <StatTile label="Delay minutes saved" value="—" hint="arrives with F3 replan" />
          </>
        )}
      </section>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Turnaround timeline (PRD F-1) — Gantt lanes land in F2 */}
        <Panel
          title="Turnaround timeline · Gantt"
          className="min-h-[280px] lg:col-span-2"
          actions={
            secondsAgo === null ? null : (
              <LiveDot
                live={secondsAgo < 5}
                label={secondsAgo < 5 ? "live" : `updated ${secondsAgo}s ago`}
              />
            )
          }
        >
          {view === "loading" ? (
            <TimelineSkeleton />
          ) : view === "error" ? (
            <ErrorState
              title="Board data unavailable"
              message={
                errorCode === "NETWORK"
                  ? "Could not reach the API. Check that the stack is running (postgres + web)."
                  : `The board request failed with code ${errorCode ?? "UNKNOWN"}. Retry — the request id below helps with tracing.`
              }
              requestId={requestId ?? undefined}
              action={
                <Button size="sm" onClick={() => setReloadToken((t) => t + 1)}>
                  Retry
                </Button>
              }
            />
          ) : view === "empty" ? (
            <EmptyState
              title="No turnaround activity"
              body="The event simulator that produces the reference day lands in F2. Once a scenario runs, every ground task appears here as a live Gantt lane."
              action={
                <Button size="sm" variant="ghost" onClick={() => setReloadToken((t) => t + 1)}>
                  Refresh
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="Scenario running"
              body="Live lanes render here once the F2 projection pipeline streams deltas. The KPI strip above shows the current freshness."
            />
          )}
        </Panel>

        {/* Event feed + alerts rail (PRD F-2/F-3 preview) */}
        <div className="flex min-h-0 flex-col gap-3">
          <Panel title="Event feed" className="min-h-[160px]">
            {view === "loading" ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : (
              <EmptyState
                title="No events yet"
                body="Every state change arrives as an immutable event (ADR-0001). The audit feed streams here from F2."
              />
            )}
          </Panel>
          <Panel title="Alerts" className="min-h-[160px]">
            <div aria-live="polite" className="h-full">
              {view === "loading" ? (
                <Skeleton className="h-4 w-2/3" />
              ) : (
                <EmptyState
                  title="No active alerts"
                  body="Risk rules raise alerts ≥ 10 min before projected SLA breaches (F3). The lifecycle (raised → acknowledged → resolved) will live here."
                />
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading board">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-5 flex-1" />
        </div>
      ))}
    </div>
  );
}

/** Scaffold review helper: /board?state=loading|empty|error forces a visual state. */
function useForcedState(): "loading" | "empty" | "error" | "live" | null {
  const [forced, setForced] = useState<"loading" | "empty" | "error" | "live" | null>(null);
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("state");
    setForced(
      raw === "loading" || raw === "empty" || raw === "error" || raw === "live" ? raw : null,
    );
  }, []);
  return forced;
}
