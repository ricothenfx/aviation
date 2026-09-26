import type { OrchestratorDb } from "../db";
import { notifications } from "../db";
import { appendEvent } from "./event-log";

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
  return {
    async publish(input: SnsPublishInput): Promise<SnsPublishResult> {
      const attributes = input.MessageAttributes ?? {};
      const pnrId = attributes.pnrId?.StringValue;
      if (!pnrId) {
        throw new Error("inbox publisher requires the pnrId message attribute");
      }
      const payload = JSON.parse(input.Message) as Record<string, unknown>;
      const subject = input.Subject ?? "Rebook.ai notification";
      const body = typeof payload.default === "string" ? payload.default : input.Message;

      // Simulated delivery: queued → delivered in one step, visible in the
      // inbox with a deliveredAt stamp (data-model.md §2 notifications).
      const [row] = await db
        .insert(notifications)
        .values({
          pnrId,
          channel: "inbox",
          state: "delivered",
          subject,
          body,
          payload: { TopicArn: input.TopicArn, Message: payload },
          deliveredAt: new Date(),
        })
        .returning({ id: notifications.id });
      if (!row) throw new Error("inbox publisher: insert returned no row");

      await appendEvent(db, {
        type: "notification.sent",
        aggregateType: "notification",
        aggregateId: row.id,
        payload: { notificationId: row.id, pnrId, channel: "inbox" },
      });
      return { MessageId: row.id };
    },
  };
}
