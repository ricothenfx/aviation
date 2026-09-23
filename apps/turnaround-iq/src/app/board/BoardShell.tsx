"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { boardSnapshotSchema, type BoardSnapshot, type WsFrame } from "@aviation/contracts";

import { EventFeed, type FeedItem } from "./EventFeed";
import { FlightDrawer } from "./FlightDrawer";
import { ScenarioPanel } from "./ScenarioPanel";
import { TurnaroundGantt } from "./TurnaroundGantt";
import { mergeFrameIntoSnapshot } from "@/lib/board/live-merge";
import { useBoardSocket } from "@/lib/board/useBoardSocket";

type FetchStatus = "loading" | "success" | "error";

/** Reference-day window (domain constants mirrored for the client viewport). */
const DAY_START = "2026-09-22T05:00:00.000Z";
const DAY_END = "2026-09-22T21:00:00.000Z";
const FEED_LIMIT = 50;

/**
 * Command board (ui-design-system.md §5 archetype 1): KPI strip → left ⅔ live
 * Gantt, right ⅓ event feed + alerts. All four mandatory states (§7): loading
 * skeleton, empty, error+retry, live-updating freshness cue. Realtime via ws
 * deltas; REST snapshot remains the fallback and catch-up source.
 */
export function BoardShell({ user }: { user: { displayName: string; role: string } }) {
  const router = useRouter();
  const [status, setStatus] = useState<FetchStatus>("loading");
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null);
  const snapshotRef = useRef<BoardSnapshot | null>(null);
  snapshotRef.current = snapshot;

  const load = useCallback(async () => {
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

  const onFrame = useCallback((frame: WsFrame) => {
    setLastFrameAt(Date.now());
    setFeed((prev) => {
      const item = toFeedItem(frame);
      if (!item) return prev;
      return [item, ...(prev ?? [])].slice(0, FEED_LIMIT);
    });
    const current = snapshotRef.current;
    if (!current) return;
    setSnapshot(mergeFrameIntoSnapshot(current, frame));
  }, []);

  const socketStatus = useBoardSocket({
    onFrame,
    onReconnect: () => void load(),
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function logout() {
    await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => null);
    router.replace("/login");
    router.refresh();
  }

  const secondsAgo = useMemo(
    () => (lastFrameAt === null ? null : Math.max(0, Math.floor((now - lastFrameAt) / 1000))),
    [now, lastFrameAt],
  );
  const isLive = snapshot?.live === true && socketStatus === "open";

  const selectedFlight = useMemo(
    () => snapshot?.flights.find((f) => f.id === selectedFlightId) ?? null,
    [snapshot, selectedFlightId],
  );

  const view =
    status === "loading"
      ? "loading"
      : status === "error"
        ? "error"
        : snapshot && snapshot.flights.length === 0
          ? "empty"
          : "live";

  const kpis = snapshot?.kpis ?? null;

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-2rem)] w-full max-w-7xl flex-col gap-3 px-4 py-3">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-accent/40 bg-raised font-mono text-xs font-bold text-accent">
            TIQ
          </div>
          <div>
            <h1 className="text-sm font-semibold text-fg">Turnaround Command Board</h1>
            <p className="text-xs text-muted">Synthetic airport · reference day · simulated data</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {snapshot ? (
            <span className="font-mono text-xs tabular-nums text-muted">
              scenario {snapshot.scenarioTs ? `${snapshot.scenarioTs.slice(11, 19)}Z` : "idle"}
            </span>
          ) : null}
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

      {/* KPI strip (PRD F-6) — honest values from live projections, "—" when absent */}
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
            <StatTile
              label="On-time departures"
              value={kpis ? `${kpis.onTimeDepPct.toFixed(1)}%` : "—"}
              hint={
                kpis ? "share of off-block turns on time" : "starts with the first completed turn"
              }
            />
            <StatTile
              label="Avg turn time"
              value={kpis && kpis.avgTurnMin > 0 ? `${kpis.avgTurnMin.toFixed(1)} min` : "—"}
              hint={
                kpis && kpis.avgTurnMin > 0
                  ? "actual in-block → off-block"
                  : "starts with the first completed turn"
              }
            />
            <StatTile
              label="Active alerts"
              value={kpis ? String(kpis.activeAlerts) : "—"}
              hint={kpis ? "raised + acknowledged" : "arrives with F3 risk rules"}
            />
            <StatTile
              label="Delay minutes saved"
              value={kpis ? String(kpis.delayMinutesSaved) : "—"}
              hint={kpis ? "replan-attributed (F3)" : "arrives with F3 replan"}
            />
          </>
        )}
      </section>

      {user.role === "supervisor" ? (
        <Panel title="Scenario console (supervisor)">
          <ScenarioPanel onChanged={() => void load()} />
        </Panel>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Turnaround timeline (PRD F-1) */}
        <Panel
          title="Turnaround timeline · Gantt"
          className="min-h-[320px] lg:col-span-2"
          contentClassName="relative"
          actions={
            <LiveDot
              live={isLive && secondsAgo !== null && secondsAgo < 5}
              label={
                socketStatus !== "open"
                  ? "ws offline — REST fallback"
                  : secondsAgo !== null && secondsAgo < 5
                    ? "live"
                    : snapshot?.live
                      ? `waiting for events · ${snapshot.flights.length} flights`
                      : `updated ${secondsAgo ?? "—"}s ago`
              }
            />
          }
        >
          {view === "loading" ? (
            <TimelineSkeleton />
          ) : view === "error" ? (
            <ErrorState
              title="Board data unavailable"
              message={
                errorCode === "NETWORK"
                  ? "Could not reach the API. Check that the stack is running (postgres + redis + web)."
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
              body="The reference day is seeded but holds no flights for this scenario. Run the reference scenario to populate the board."
            />
          ) : (
            <div className="flex h-full min-h-[280px] flex-col gap-2">
              <div className="min-h-0 flex-1">
                <TurnaroundGantt
                  flights={snapshot?.flights ?? []}
                  windowStart={DAY_START}
                  windowEnd={DAY_END}
                  onSelectFlight={setSelectedFlightId}
                />
              </div>
              <StatusLegend />
            </div>
          )}
        </Panel>

        {/* Event feed + alerts rail */}
        <div className="flex min-h-0 flex-col gap-3">
          <Panel title="Event feed" className="min-h-[200px] flex-1">
            <EventFeed items={feed} loading={view === "loading"} />
          </Panel>
          <Panel title="Alerts" className="min-h-[140px]">
            <div aria-live="polite" className="h-full">
              <AlertsRail
                alerts={snapshot?.alerts ?? []}
                flights={snapshot?.flights ?? []}
                canAct={user.role !== "viewer"}
                onAct={async (alertId, kind) => {
                  const res = await fetch(`/api/v1/alerts/${alertId}/${kind}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body:
                      kind === "resolve"
                        ? JSON.stringify({ note: "resolved from board" })
                        : undefined,
                  });
                  if (res.ok) {
                    setSnapshot((prev) =>
                      prev
                        ? {
                            ...prev,
                            alerts: prev.alerts.map((alert) =>
                              alert.id === alertId
                                ? {
                                    ...alert,
                                    state: kind === "acknowledge" ? "acknowledged" : "resolved",
                                  }
                                : alert,
                            ),
                          }
                        : prev,
                    );
                  }
                }}
              />
            </div>
          </Panel>
        </div>
      </div>

      {selectedFlight && snapshot ? (
        <FlightDrawer
          flight={selectedFlight}
          scenarioTs={snapshot.scenarioTs}
          userRole={user.role}
          onClose={() => setSelectedFlightId(null)}
        />
      ) : null}
    </div>
  );
}

type RailAlert = BoardSnapshot["alerts"][number];

/** Alert lifecycle rail (PRD F-3): severity, rule, lead time + ack/resolve. */
function AlertsRail({
  alerts,
  flights,
  canAct,
  onAct,
}: {
  alerts: RailAlert[];
  flights: BoardSnapshot["flights"];
  canAct: boolean;
  onAct: (alertId: string, kind: "acknowledge" | "resolve") => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (alerts.length === 0) {
    return (
      <EmptyState
        title="No active alerts"
        body="Risk rules raise alerts ≥ 10 min before projected SLA breaches (PRD F-3). Inject a disruption to see the engine work."
      />
    );
  }
  const flightNoById = new Map(flights.map((flight) => [flight.id, flight.flightNo]));
  return (
    <ul className="space-y-1.5">
      {alerts.map((alert) => (
        <li
          key={alert.id}
          className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            <StatusBadge
              tone={
                alert.severity === "critical"
                  ? "danger"
                  : alert.severity === "warning"
                    ? "warn"
                    : "info"
              }
            >
              {alert.state}
            </StatusBadge>
            <div className="min-w-0">
              <p className="truncate font-mono text-xs text-fg">{alert.ruleId}</p>
              <p className="truncate text-[11px] text-muted">
                {flightNoById.get(alert.flightId) ?? "flight"}
                {alert.leadTimeMin !== null ? ` · leads breach by ${alert.leadTimeMin} min` : ""}
              </p>
            </div>
          </div>
          {canAct ? (
            <div className="flex shrink-0 gap-1">
              {alert.state === "raised" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(alert.id);
                    void onAct(alert.id, "acknowledge").finally(() => setBusy(null));
                  }}
                >
                  Ack
                </Button>
              ) : null}
              {alert.state !== "resolved" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(alert.id);
                    void onAct(alert.id, "resolve").finally(() => setBusy(null));
                  }}
                >
                  Resolve
                </Button>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function toFeedItem(frame: WsFrame): FeedItem | null {
  const payload = frame.payload as {
    flightId?: string;
    taskId?: string;
    scenarioTs?: string;
    state?: string;
  };
  let label = "";
  if (payload.state) label = `${payload.state}`;
  else if (payload.scenarioTs) label = `${payload.scenarioTs.slice(11, 19)}Z`;
  else if (payload.taskId) label = payload.taskId.slice(0, 8);
  return { id: frame.id, ts: frame.ts, type: frame.type, label };
}

function StatusLegend() {
  const entries: [string, string][] = [
    ["tiq-item-scheduled", "scheduled"],
    ["tiq-item-inblock", "in block"],
    ["tiq-item-turnaround", "turnaround"],
    ["tiq-item-delayed", "delayed"],
    ["tiq-item-offblock", "off block"],
  ];
  return (
    <ul className="flex flex-wrap items-center gap-3" aria-label="Status legend">
      {entries.map(([cls, label]) => (
        <li key={cls} className="flex items-center gap-1.5 text-xs text-muted">
          <span aria-hidden className={`inline-block h-2.5 w-4 rounded-sm ${cls}`} />
          {label}
        </li>
      ))}
    </ul>
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
