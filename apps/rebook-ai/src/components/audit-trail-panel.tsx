"use client";

import { useCallback, useEffect, useState } from "react";

import {
  Button,
  EmptyState,
  ErrorState,
  LiveDot,
  Panel,
  Skeleton,
  StatusBadge,
} from "@aviation/ui";
import type { AuditTrailView } from "@aviation/contracts";

/**
 * Supervisor audit trail (PRD F-7, demo-script beat 80–90 s: "audit trail
 * view answers who decided what for whom, when"). Reads the append-only
 * `audit_events` trail via GET /api/v1/admin/audit (api-contracts.md §1,
 * additive F4) with a 5 s poll; loading/empty/error states per
 * ui-design-system §7.
 */

const ACTION_TONE: Record<string, "ok" | "warn" | "danger" | "info" | "muted"> = {
  "offer.confirmed": "ok",
  "proposal.approved": "ok",
  "proposal.rejected": "danger",
  "saga.compensated": "warn",
  "scenario.injected": "warn",
};

function hhmmss(iso: string): string {
  return iso.slice(11, 19);
}

export function AuditTrailPanel() {
  const [state, setState] = useState<
    { phase: "loading" } | { phase: "ready"; data: AuditTrailView } | { phase: "error" }
  >({ phase: "loading" });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/admin/audit?limit=50");
      if (!res.ok) {
        setState({ phase: "error" });
        return;
      }
      setState({ phase: "ready", data: (await res.json()) as AuditTrailView });
    } catch {
      setState({ phase: "error" });
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load]);

  if (state.phase === "loading") {
    return (
      <Panel className="p-0">
        <div className="border-b border-border px-4 py-2.5">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="space-y-2 p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </div>
      </Panel>
    );
  }

  if (state.phase === "error") {
    return (
      <Panel className="p-0">
        <ErrorState
          title="Audit trail unavailable"
          message="The decision trail could not be loaded from the rebook_ai database."
          action={
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      </Panel>
    );
  }

  const { entries } = state.data;

  return (
    <Panel className="p-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-fg">Audit trail</span>
          <LiveDot live label="live" />
        </div>
        <span className="text-[10px] text-muted">append-only · latest {entries.length}</span>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title="No decisions recorded yet"
          body="Every confirm, approval, rejection and scenario injection lands here as an append-only audit row — who decided what for whom, when."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] border-collapse text-left">
            <caption className="sr-only">Append-only decision audit trail</caption>
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted">
                <th scope="col" className="px-4 py-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Actor
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Action
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  PNR
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Target
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {entries.map((entry) => (
                <tr key={entry.id} data-testid="audit-row" className="align-top">
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-[11px] text-muted">
                    {hhmmss(entry.createdAt)}
                  </td>
                  <td className="px-4 py-2 text-[11px]">
                    <div className="text-fg">{entry.actor}</div>
                    <StatusBadge
                      tone={entry.actorRole === "supervisor" ? "warn" : "muted"}
                      className="mt-0.5"
                    >
                      {entry.actorRole}
                    </StatusBadge>
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge tone={ACTION_TONE[entry.action] ?? "info"}>
                      {entry.action}
                    </StatusBadge>
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-fg">
                    {entry.locator ?? "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-[10px] text-muted">
                    {entry.targetType}:{entry.targetId.slice(0, 8)}…
                  </td>
                  <td className="max-w-[16rem] px-4 py-2 font-mono text-[10px] text-muted">
                    <span className="line-clamp-2 break-all opacity-80">
                      {entry.details ? JSON.stringify(entry.details) : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
