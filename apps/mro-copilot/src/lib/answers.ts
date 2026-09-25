import { asc, eq, inArray } from "drizzle-orm";

import { type MroDb } from "@/db/client";
import { getSingletonDb } from "@/lib/db-singleton";
import { answerCitations, answers, auditEvents, users } from "@/db/schema";
import type { AnswerDetail, AnswerSummary, AuditEvent, Citation } from "@/lib/api/schemas";

/**
 * Shared answer queries for the answers/reviews endpoints (api-contracts.md
 * §1 Copilot Q&A). Visibility is enforced by the route handlers — this module
 * only loads rows and maps them to the wire shapes.
 */

export async function loadAnswerDetail(id: string): Promise<AnswerDetail | null> {
  const rows = await loadAnswerDetails([id]);
  return rows[0] ?? null;
}

export async function loadAnswerDetails(ids: string[]): Promise<AnswerDetail[]> {
  const db: MroDb = getSingletonDb();
  const rows = await db
    .select({
      id: answers.id,
      question: answers.question,
      status: answers.status,
      source: answers.source,
      provider: answers.provider,
      refusalReason: answers.refusalReason,
      groundingScore: answers.groundingScore,
      answerText: answers.answerText,
      retrievalMeta: answers.retrievalMeta,
      createdBy: answers.createdBy,
      createdAt: answers.createdAt,
      review: answers.review,
      authorName: users.displayName,
    })
    .from(answers)
    .innerJoin(users, eq(users.id, answers.createdBy))
    .where(inArray(answers.id, ids));

  if (rows.length === 0) return [];

  const citationRows = await db
    .select()
    .from(answerCitations)
    .where(
      inArray(
        answerCitations.answerId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(answerCitations.seq));

  const citationsByAnswer = new Map<string, Citation[]>();
  for (const c of citationRows) {
    const list = citationsByAnswer.get(c.answerId) ?? [];
    list.push({
      chunkId: c.chunkId,
      manualId: c.manualId,
      docType: c.docType,
      ataChapter: c.ataChapter,
      taskNo: c.taskNo,
      sectionPath: c.sectionPath,
      page: c.page,
      revision: c.revision,
      snippet: c.snippet,
    });
    citationsByAnswer.set(c.answerId, list);
  }

  return (
    rows
      .map((row) => ({
        id: row.id,
        question: row.question,
        status: row.status,
        source: row.source,
        provider: row.provider,
        refusalReason: parseRefusalReason(row.refusalReason),
        groundingScore: row.groundingScore,
        answerText: row.answerText,
        citations: citationsByAnswer.get(row.id) ?? [],
        retrievalMeta: row.retrievalMeta as AnswerDetail["retrievalMeta"],
        citationCount: (citationsByAnswer.get(row.id) ?? []).length,
        createdBy: row.createdBy,
        createdByName: row.authorName,
        createdAt: row.createdAt.toISOString(),
        review: parseReview(row.review),
      }))
      // Preserve the caller's id order (the route ordered by createdAt; the
      // detail fetch is unordered).
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
  );
}

function parseRefusalReason(raw: string | null): AnswerDetail["refusalReason"] {
  return raw === "below_grounding_threshold" || raw === "no_valid_citations" ? raw : null;
}

export function toSummary(detail: AnswerDetail): AnswerSummary {
  return {
    id: detail.id,
    question: detail.question,
    status: detail.status,
    source: detail.source,
    provider: detail.provider,
    refusalReason: detail.refusalReason,
    groundingScore: detail.groundingScore,
    citationCount: detail.citationCount,
    createdBy: detail.createdBy,
    createdByName: detail.createdByName,
    createdAt: detail.createdAt,
    review: detail.review,
  };
}

export async function loadAnswerAudit(answerId: string): Promise<AuditEvent[]> {
  const db: MroDb = getSingletonDb();
  const rows = await db
    .select({
      id: auditEvents.id,
      sequence: auditEvents.sequence,
      eventType: auditEvents.eventType,
      actorName: users.displayName,
      payload: auditEvents.payload,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorId))
    .where(eq(auditEvents.answerId, answerId))
    .orderBy(asc(auditEvents.sequence));
  return rows.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    eventType: row.eventType,
    actorName: row.actorName ?? null,
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
}

interface ReviewJson {
  reviewerId: string;
  reviewerName?: string;
  note: string | null;
  at: string;
}

function parseReview(raw: unknown): AnswerDetail["review"] {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ReviewJson>;
  if (!r.reviewerId || !r.at) return null;
  return {
    reviewerId: r.reviewerId,
    reviewerName: r.reviewerName ?? "reviewer",
    note: r.note ?? null,
    at: r.at,
  };
}
