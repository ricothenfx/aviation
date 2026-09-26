import { z } from "zod";

/**
 * rebook-ai REST read-models, request payloads and live-frame schemas
 * (rebook-ai api-contracts.md §1/§3/§5, additive at F2 per the D-11/D-14
 * precedent). Event payload schemas live in ./events; this module covers what
 * the web surface exchanges and what `chan:rb:live` fans out.
 */

const uuid = z.string().uuid();
const isoTs = z.string().datetime({ offset: true });

export const pnrTierSchema = z.enum(["standard", "silver", "gold"]);
export type PnrTier = z.infer<typeof pnrTierSchema>;

export const offerStateSchema = z.enum(["proposed", "confirmed", "expired", "superseded"]);
export type OfferState = z.infer<typeof offerStateSchema>;

export const sagaStateSchema = z.enum(["running", "completed", "failed", "compensated"]);
export type SagaState = z.infer<typeof sagaStateSchema>;

export const optionKindSchema = z.enum(["fast", "cheap", "flexible"]);
export type OptionKind = z.infer<typeof optionKindSchema>;

// --- passenger surface (api-contracts.md §1 /pax/*) --------------------------

export const itinerarySegmentSchema = z.object({
  airline: z.string().min(1),
  flightNo: z.string().min(1),
  origin: z.string().min(3).max(4),
  dest: z.string().min(3).max(4),
  depart: isoTs,
  arrive: isoTs,
  cabin: z.string().min(1),
});
export type ItinerarySegment = z.infer<typeof itinerarySegmentSchema>;

export const offerOptionViewSchema = z.object({
  id: uuid,
  rank: z.number().int().positive(),
  kind: optionKindSchema,
  /** Human-readable per-rank reason (PRD F-2). */
  reason: z.string().min(1),
  segments: z.array(itinerarySegmentSchema).min(1),
  fareDelta: z.number().int(),
  currency: z.string().min(1),
  /** Supervisor path required for passengers (api-contracts.md §1 confirm). */
  interline: z.boolean(),
  refundable: z.boolean(),
  changeable: z.boolean(),
  /** Above the tier fare cap — agent review path (architecture.md §3.3). */
  overCap: z.boolean(),
});
export type OfferOptionView = z.infer<typeof offerOptionViewSchema>;

/** Explainable voucher criteria row (PRD F-3): inputs + evaluated values. */
export const voucherCriteriaEntrySchema = z.object({
  rule: z.string().min(1),
  description: z.string().min(1),
  met: z.boolean(),
  detail: z.string().min(1),
});
export type VoucherCriteriaEntry = z.infer<typeof voucherCriteriaEntrySchema>;

export const voucherViewSchema = z.object({
  id: uuid,
  amount: z.number().int().positive(),
  currency: z.string().min(1),
  state: z.enum(["issued", "used"]),
  reason: z.string().min(1),
  criteria: z.array(voucherCriteriaEntrySchema).min(1),
  issuedAt: isoTs,
});
export type VoucherView = z.infer<typeof voucherViewSchema>;

export const notificationViewSchema = z.object({
  id: uuid,
  channel: z.literal("inbox"),
  state: z.enum(["queued", "delivered", "failed"]),
  subject: z.string().min(1),
  body: z.string().min(1),
  createdAt: isoTs,
});
export type NotificationView = z.infer<typeof notificationViewSchema>;

export const sagaStepViewSchema = z.object({
  step: z.enum(["seat_reserve", "payment", "ticket_issue"]),
  state: z.enum(["pending", "running", "done", "failed", "compensated"]),
});
export type SagaStepView = z.infer<typeof sagaStepViewSchema>;

export const sagaViewSchema = z.object({
  id: uuid,
  state: sagaStateSchema,
  currentStep: z.string().nullable(),
  steps: z.array(sagaStepViewSchema),
});
export type SagaView = z.infer<typeof sagaViewSchema>;

export const offerContextViewSchema = z.object({
  flightNo: z.string().min(1),
  disruptionKind: z.enum(["cancellation", "long_delay"]),
  delayMinutes: z.number().int().nonnegative(),
  reasonCode: z.string().min(1),
  voucherIssued: z.boolean(),
  /** sha256 over the ranked option set — determinism evidence (F2 DoD). */
  rankingHash: z.string().min(1),
});
export type OfferContextView = z.infer<typeof offerContextViewSchema>;

export const offerSetViewSchema = z.object({
  id: uuid,
  pnrId: uuid,
  state: offerStateSchema,
  expiresAt: isoTs,
  createdAt: isoTs,
  options: z.array(offerOptionViewSchema),
  context: offerContextViewSchema,
  /** Set once confirmed; carries the opened saga (stub steps at F2). */
  confirmation: z
    .object({
      optionId: uuid,
      byRole: z.enum(["passenger", "agent", "supervisor"]),
      confirmedAt: isoTs,
      saga: sagaViewSchema,
    })
    .nullable(),
});
export type OfferSetView = z.infer<typeof offerSetViewSchema>;

export const disruptionViewSchema = z.object({
  flightNo: z.string().min(1),
  kind: z.enum(["cancellation", "long_delay"]),
  delayMinutes: z.number().int().nonnegative().nullable(),
  reasonCode: z.string().min(1),
  origin: z.string().min(3).max(4),
  dest: z.string().min(3).max(4),
  schedDep: isoTs,
  disruptedAt: isoTs,
});
export type DisruptionView = z.infer<typeof disruptionViewSchema>;

/** GET /api/v1/pax/summary (api-contracts.md §1) — ownership-scoped. */
export const paxSummaryViewSchema = z.object({
  passenger: z.object({ name: z.string().min(1), email: z.string().email() }),
  disruption: disruptionViewSchema.nullable(),
  offers: z.array(offerSetViewSchema),
  vouchers: z.array(voucherViewSchema),
  notifications: z.array(notificationViewSchema),
});
export type PaxSummaryView = z.infer<typeof paxSummaryViewSchema>;

// --- confirm (api-contracts.md §1/§5) ----------------------------------------

export const offerConfirmRequestSchema = z.object({ optionId: uuid });
export type OfferConfirmRequest = z.infer<typeof offerConfirmRequestSchema>;

export const offerConfirmResponseSchema = z.object({
  offerId: uuid,
  optionId: uuid,
  sagaId: uuid,
  sagaState: sagaStateSchema,
});
export type OfferConfirmResponse = z.infer<typeof offerConfirmResponseSchema>;

// --- agent console (api-contracts.md §1 /queue, /pnr) ------------------------

export const queueItemViewSchema = z.object({
  pnrId: uuid,
  locator: z.string().min(6).max(6),
  passengerName: z.string().min(1),
  tier: pnrTierSchema,
  partySize: z.number().int().positive(),
  flightNo: z.string().min(1),
  disruptionKind: z.enum(["cancellation", "long_delay"]),
  disruptedAt: isoTs,
  /** Minutes since the disruption event (scenario wall clock). */
  waitMinutes: z.number().int().nonnegative(),
  /** Queue score (tier + kind + wait) — higher = served first (PRD F-4). */
  priority: z.number(),
  offerState: offerStateSchema.nullable(),
});
export type QueueItemView = z.infer<typeof queueItemViewSchema>;

export const queueSnapshotViewSchema = z.object({
  items: z.array(queueItemViewSchema),
  waiting: z.number().int().nonnegative(),
  /** null = honest "not measurable" when no disruption is active (D-15). */
  containmentPct: z.number().min(0).max(100).nullable(),
  generatedAt: isoTs,
});
export type QueueSnapshotView = z.infer<typeof queueSnapshotViewSchema>;

export const pnrDetailViewSchema = z.object({
  locator: z.string().min(6).max(6),
  passengerName: z.string().min(1),
  tier: pnrTierSchema,
  fareClass: z.string().min(1),
  partySize: z.number().int().positive(),
  contactHandle: z.string().min(1),
  segments: z.array(
    z.object({
      airline: z.string().min(1),
      flightNo: z.string().min(1),
      flightDate: isoTs,
      origin: z.string().min(3).max(4),
      dest: z.string().min(3).max(4),
      cabin: z.string().min(1),
      status: z.enum(["confirmed", "delayed", "cancelled", "rebooked"]),
    }),
  ),
  disruption: disruptionViewSchema.nullable(),
  offers: z.array(offerSetViewSchema),
});
export type PnrDetailView = z.infer<typeof pnrDetailViewSchema>;

// --- scenario control (api-contracts.md §1 /scenario/inject) ------------------

export const scenarioInjectRequestSchema = z.object({
  scenario: z.enum(["cancellation", "long-delay"]),
  flightNo: z.string().min(1),
});
export type ScenarioInjectRequest = z.infer<typeof scenarioInjectRequestSchema>;

export const scenarioInjectResponseSchema = z.object({
  eventId: uuid,
  flightNo: z.string().min(1),
  disruptionKind: z.enum(["cancellation", "long_delay"]),
  affectedPnrs: z.number().int().nonnegative(),
  delayMinutes: z.number().int().nonnegative().nullable(),
});
export type ScenarioInjectResponse = z.infer<typeof scenarioInjectResponseSchema>;

// --- supervisor: poison events (architecture.md §6, additive F2) --------------

export const poisonEventViewSchema = z.object({
  id: uuid,
  type: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: uuid,
  occurredAt: isoTs,
  attempts: z.number().int().nonnegative(),
  processError: z.string().min(1),
});
export type PoisonEventView = z.infer<typeof poisonEventViewSchema>;

// --- live frames on chan:rb:live (api-contracts.md §3) ------------------------

export const queueDeltaPayloadSchema = z.object({
  waiting: z.number().int().nonnegative(),
  containmentPct: z.number().min(0).max(100).nullable(),
  reason: z.enum(["disruption", "confirm", "expiry", "rebuild"]),
});
export type QueueDeltaPayload = z.infer<typeof queueDeltaPayloadSchema>;

export const offersUpdatePayloadSchema = z.object({
  pnrId: uuid,
  offerId: uuid,
  state: offerStateSchema,
  voucherIssued: z.boolean().optional(),
});
export type OffersUpdatePayload = z.infer<typeof offersUpdatePayloadSchema>;

export const sagaUpdatePayloadSchema = z.object({
  pnrId: uuid,
  sagaId: uuid,
  state: sagaStateSchema,
  currentStep: z.string().nullable(),
});
export type SagaUpdatePayload = z.infer<typeof sagaUpdatePayloadSchema>;

/** One frame shape per type — union mirrors the ws envelope (D-14 precedent). */
export const rebookLiveFrameSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    ts: isoTs,
    channel: z.string().min(1),
    type: z.literal("queue.delta"),
    payload: queueDeltaPayloadSchema,
    lastEventId: z.string().min(1).nullable(),
  }),
  z.object({
    id: z.string().min(1),
    ts: isoTs,
    channel: z.string().min(1),
    type: z.literal("offers.update"),
    payload: offersUpdatePayloadSchema,
    lastEventId: z.string().min(1).nullable(),
  }),
  z.object({
    id: z.string().min(1),
    ts: isoTs,
    channel: z.string().min(1),
    type: z.literal("saga.update"),
    payload: sagaUpdatePayloadSchema,
    lastEventId: z.string().min(1).nullable(),
  }),
]);
export type RebookLiveFrame = z.infer<typeof rebookLiveFrameSchema>;

export const REBOOK_LIVE_CHANNEL = "chan:rb:live";
export const REBOOK_CONTROL_CHANNEL = "chan:rb:control";
