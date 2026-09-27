import type { OrchestratorDb } from "../db";
import { notifications } from "../db";
import { appendEvents } from "./event-log";

/**
 * SNS-shaped notification publisher (PRD F-1, rebook-ai architecture.md §2,
 * tech-stack.md §2 AWS mapping row "notifications → SNS"). The publish input
 * mirrors an SNS `PublishInput` (TopicArn/Message/MessageAttributes) so the
 * local in-app inbox implementation is a drop-in swap for a real SNS client.
 * Delivery is SIMULATED: the message lands as an in-app inbox row marked
 * delivered — never a real email/SMS/push (PRD §4 OUT OF SCOPE).
 */

export interface SnsPublishInput {
  /** Simulated topic ARN — names the fan-out topic, never a real AWS resource. */
  TopicArn: string;
  /** JSON string payload for the subscriber (the inbox row here). */
  Message: string;
  Subject?: string;
  MessageAttributes?: Record<string, { DataType: string; StringValue: string }>;
}

export interface SnsPublishResult {
  /** Simulated message id — equals the inbox notification id (traceable). */
  MessageId: string;
}

export interface NotificationPublisher {
  publish(input: SnsPublishInput): Promise<SnsPublishResult>;
  /**
   * Batched fan-out (ADR-0016 amendment): ONE multi-row inbox insert for a
   * burst (a disrupted flight's PNRs). SNS-shape is per-message unchanged.
   */
  publishAll(inputs: readonly SnsPublishInput[]): Promise<SnsPublishResult[]>;
}

export interface DisruptionMessage {
  pnrId: string;
  locator: string;
  passengerName: string;
  flightNo: string;
  disruptionKind: "cancellation" | "long_delay";
  delayMinutes: number | null;
  offerId: string;
  optionCount: number;
  voucherAmount: number | null;
  voucherCurrency: string | null;
  expiresAt: string;
}

export function buildDisruptionPublishInput(message: DisruptionMessage): SnsPublishInput {
  const topic =
    message.disruptionKind === "cancellation" ? "rebook-cancellation" : "rebook-long-delay";
  const kindText =
    message.disruptionKind === "cancellation"
      ? `Your flight ${message.flightNo} was cancelled.`
      : `Your flight ${message.flightNo} is delayed by ${message.delayMinutes ?? 0} minutes.`;
  const voucherText =
    message.voucherAmount !== null
      ? ` A ${message.voucherCurrency} ${message.voucherAmount} meal voucher was added automatically.`
      : "";
  return {
    TopicArn: `arn:aws:sns:ap-southeast-1:111111111111:${topic}`,
    Subject: `${message.flightNo}: ${message.disruptionKind === "cancellation" ? "cancelled" : "long delay"} — rebooking options ready`,
    Message: JSON.stringify({
      default: `${kindText} ${message.optionCount} ranked rebooking option(s) are waiting in your trip view.${voucherText}`,
      ...message,
    }),
    MessageAttributes: {
      pnrId: { DataType: "String", StringValue: message.pnrId },
      locator: { DataType: "String", StringValue: message.locator },
      disruptionKind: { DataType: "String", StringValue: message.disruptionKind },
      offerId: { DataType: "String", StringValue: message.offerId },
    },
  };
}

export function createInboxNotificationPublisher(db: OrchestratorDb): NotificationPublisher {
  function decode(input: SnsPublishInput): {
    pnrId: string;
    subject: string;
    body: string;
    topicArn: string;
    payload: Record<string, unknown>;
  } {
    const attributes = input.MessageAttributes ?? {};
    const pnrId = attributes.pnrId?.StringValue;
    if (!pnrId) {
      throw new Error("inbox publisher requires the pnrId message attribute");
    }
    const payload = JSON.parse(input.Message) as Record<string, unknown>;
    const subject = input.Subject ?? "Rebook.ai notification";
    const body = typeof payload.default === "string" ? payload.default : input.Message;
    return { pnrId, subject, body, topicArn: input.TopicArn, payload };
  }

  return {
    async publish(input: SnsPublishInput): Promise<SnsPublishResult> {
      const results = await this.publishAll([input]);
      const [row] = results;
      if (!row) throw new Error("inbox publisher: batch returned no result");
      return row;
    },

    async publishAll(inputs): Promise<SnsPublishResult[]> {
      if (inputs.length === 0) return [];
      const decoded = inputs.map(decode);
      // Simulated delivery: queued → delivered in one step, visible in the
      // inbox with a deliveredAt stamp (data-model.md §2 notifications).
      const inserted = await db
        .insert(notifications)
        .values(
          decoded.map(({ pnrId, subject, body, topicArn, payload }) => ({
            pnrId,
            channel: "inbox" as const,
            state: "delivered" as const,
            subject,
            body,
            payload: { TopicArn: topicArn, Message: payload },
            deliveredAt: new Date(),
          })),
        )
        .returning({ id: notifications.id });
      if (inserted.length !== decoded.length) {
        throw new Error(`inbox publisher: insert lost rows (${inserted.length}/${decoded.length})`);
      }

      await appendEvents(
        db,
        inserted.map((row, i) => ({
          type: "notification.sent" as const,
          aggregateType: "notification" as const,
          aggregateId: row.id,
          payload: {
            notificationId: row.id,
            pnrId: decoded[i]!.pnrId,
            channel: "inbox" as const,
          },
        })),
      );
      return inserted.map((row) => ({ MessageId: row.id }));
    },
  };
}
