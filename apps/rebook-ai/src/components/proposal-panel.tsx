"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button, EmptyState, Panel, StatusBadge } from "@aviation/ui";
import type { ProposalView } from "@aviation/contracts";

/**
 * Agent console proposal cards (PRD F-5, milestones.md F3): request a
 * propose-only agent-loop proposal, inspect the full tool trace with the
 * `source`/`provider` honesty badges (D-10), approve/reject with the
 * supervisor elevation gate surfaced. Live saga progress + boarding pass
 * arrive through the PNR detail refetch after approval (architecture §3.3).
 */

const TOOL_LABEL: Record<string, string> = {
  search_routings: "search_routings",
  price_itinerary: "price_itinerary",
  check_policy: "check_policy",
  draft_proposal: "draft_proposal",
};

interface ProposalPanelProps {
  locator: string;
  proposals: ProposalView[];
  onChanged: () => void;
}

export function ProposalPanel({ locator, proposals, onChanged }: ProposalPanelProps) {
  const [requesting, setRequesting] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // Poll the freshly requested proposal until the orchestrator persists it
  // (404 = still preparing — rendered honestly, never fabricated progress).
  useEffect(() => {
    if (!pendingId) return;
    const startedAt = Date.now();
    pollTimer.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/v1/proposals/${pendingId}`);
        if (res.ok) {
          stopPolling();
          setPendingId(null);
          onChanged();
          return;
        }
        if (Date.now() - startedAt > 30_000) {
          stopPolling();
          setPendingId(null);
          setError("the agent loop has not produced a proposal — try again");
        }
      } catch {
        /* transient network hiccup — keep polling until the deadline */
      }
    }, 600);
    return stopPolling;
  }, [pendingId, stopPolling, onChanged]);

  async function requestProposal(): Promise<void> {
    setRequesting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/pnr/${locator}/proposal`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      const body = (await res.json().catch(() => null)) as {
        proposalId?: string;
        error?: { message?: string };
      } | null;
      if (!res.ok || !body?.proposalId) {
        setError(body?.error?.message ?? `proposal request failed (HTTP ${res.status})`);
        return;
      }
      setPendingId(body.proposalId);
    } catch {
      setError("network error — is the stack running?");
    } finally {
      setRequesting(false);
    }
  }

  async function decide(proposal: ProposalView, action: "approve" | "reject"): Promise<void> {
    setDeciding(proposal.id);
    setError(null);
    try {
      const res = await fetch(`/api/v1/proposals/${proposal.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "reject"
            ? { note: note.trim() || "Rejected by agent" }
            : note.trim()
              ? { note: note.trim() }
              : {},
        ),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `${action} failed (HTTP ${res.status})`);
        return;
      }
      setNote("");
      onChanged();
    } catch {
      setError("network error — try again");
    } finally {
      setDeciding(null);
    }
  }

  return (
    <div className="grid gap-2" data-testid="proposal-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
          Agent proposals
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={requesting || pendingId !== null}
          onClick={() => void requestProposal()}
          data-testid="request-proposal"
        >
          {pendingId ? "Preparing…" : requesting ? "Requesting…" : "Request proposal"}
        </Button>
      </div>

      {pendingId && (
        <p className="text-[11px] text-muted" data-testid="proposal-preparing">
          Agent loop running — tracing tool calls…
        </p>
      )}
      {error && (
        <p className="text-[11px] text-danger" role="alert">
          {error}
        </p>
      )}

      {proposals.length === 0 && !pendingId ? (
        <p className="text-[11px] text-muted">
          No proposals yet — request one to have the agent search routings, price options and check
          policy, then review its recommendation here.
        </p>
      ) : (
        proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            deciding={deciding}
            note={note}
            onNote={setNote}
            onDecide={decide}
          />
        ))
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  deciding,
  note,
  onNote,
  onDecide,
}: {
  proposal: ProposalView;
  deciding: string | null;
  note: string;
  onNote: (note: string) => void;
  onDecide: (proposal: ProposalView, action: "approve" | "reject") => Promise<void>;
}) {
  const [traceOpen, setTraceOpen] = useState(false);
  return (
    <div data-testid="proposal-card">
      <Panel className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="info">proposal</StatusBadge>
          {/* Honesty badges (D-10): source + provider, never unlabeled. */}
          <span data-testid="proposal-source">
            <StatusBadge tone={proposal.source === "llm" ? "ok" : "warn"}>
              {`source: ${proposal.source}`}
            </StatusBadge>
          </span>
          <StatusBadge tone="muted">{`provider: ${proposal.provider}`}</StatusBadge>
          <StatusBadge
            tone={
              proposal.state === "approved"
                ? "ok"
                : proposal.state === "rejected"
                  ? "danger"
                  : "warn"
            }
          >
            {proposal.state}
          </StatusBadge>
          <span className="ml-auto font-mono text-[10px] text-muted">
            tokens {proposal.tokensIn}/{proposal.tokensOut}
          </span>
        </div>

        <p className="mt-2 text-xs leading-relaxed text-fg">{proposal.rationale}</p>

        {proposal.requiresSupervisor.required && (
          <p className="mt-1 text-[11px] font-medium text-warn" data-testid="proposal-gate">
            Supervisor approval required: {proposal.requiresSupervisor.reasons.join("; ")}
          </p>
        )}

        <button
          type="button"
          onClick={() => setTraceOpen((open) => !open)}
          className="mt-2 text-[11px] text-muted underline decoration-dotted focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="proposal-trace-toggle"
        >
          {traceOpen ? "Hide" : "Show"} tool trace ({proposal.trace.length} calls)
        </button>
        {traceOpen && (
          <ul
            className="mt-1 space-y-1 rounded-md border border-border bg-raised/40 p-2"
            data-testid="proposal-trace"
          >
            {proposal.trace.map((call, idx) => (
              <li key={`${call.tool}-${idx}`} className="font-mono text-[10px] text-muted">
                <span className="text-fg">{TOOL_LABEL[call.tool] ?? call.tool}</span>
                {" · "}
                {call.durationMs}ms
                {call.tokens ? ` · tokens ${call.tokens.input}/${call.tokens.output}` : ""}
                <span className="block break-all opacity-70">
                  in {JSON.stringify(call.input).slice(0, 140)}
                </span>
                <span className="block break-all opacity-70">
                  out {JSON.stringify(call.output).slice(0, 160)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {proposal.note && (
          <p className="mt-2 text-[11px] text-muted">
            Note{proposal.approver ? ` (${proposal.approver})` : ""}: {proposal.note}
          </p>
        )}
        {proposal.sagaId && (
          <p className="mt-2 font-mono text-[10px] text-muted" data-testid="proposal-saga-link">
            saga: {proposal.sagaId.slice(0, 8)}… — track progress in the offer panel
          </p>
        )}

        {proposal.state === "proposed" && (
          <div className="mt-3 grid gap-2">
            <input
              type="text"
              value={note}
              onChange={(event) => onNote(event.target.value)}
              placeholder="Decision note (required on reject)"
              className="w-full rounded-md border border-border bg-raised/40 px-2 py-1.5 text-xs text-fg focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="proposal-note"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={deciding !== null}
                onClick={() => void onDecide(proposal, "approve")}
                data-testid="proposal-approve"
              >
                {deciding === proposal.id ? "Working…" : "Approve"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={deciding !== null}
                onClick={() => void onDecide(proposal, "reject")}
                data-testid="proposal-reject"
              >
                Reject
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

export function ProposalEmpty({ message }: { message: string }) {
  return <EmptyState title="No proposals" body={message} />;
}
