import { getSingletonDb } from "@/lib/db-singleton";
import { auditEvents, type NewAuditEventRow } from "@/db/schema";

import { logger } from "./logger";

/**
 * Append-only audit writer (data-model.md §2, PRD FR-14). INSERT-only by
 * construction; the migration-level trigger blocks UPDATE/DELETE for any role.
 */
export async function recordAudit(
  event: Omit<NewAuditEventRow, "id" | "sequence" | "createdAt">,
): Promise<void> {
  const db = getSingletonDb();
  await db.insert(auditEvents).values(event);
  logger.info({
    msg: "audit_event",
    eventType: event.eventType,
    answerId: event.answerId ?? null,
    actorId: event.actorId ?? null,
  });
}
