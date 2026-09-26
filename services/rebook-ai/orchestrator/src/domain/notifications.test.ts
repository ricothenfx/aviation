import { describe, expect, it } from "vitest";

import { eventPayloadSchemas } from "@aviation/contracts";

import type { OrchestratorDb } from "../db";
import {
  buildDisruptionPublishInput,
  createInboxNotificationPublisher,
  type DisruptionMessage,
  type SnsPublishInput,
} from "./notifications";

/**
 * SNS-shaped publisher tests (PRD F-1, tech-stack.md §2 mapping): the publish
 * input mirrors an SNS PublishInput; the inbox implementation persists a
 * delivered row + appends notification.sent (both asserted against a fake db).
 */

const MESSAGE: DisruptionMessage = {
  pnrId: "00000000-0000-4000-8000-000000000001",
  locator: "NXQ4ZK",
  passengerName: "Nadia Cho",
  flightNo: "NX 288",
  disruptionKind: "cancellation",
  delayMinutes: null,
  offerId: "00000000-0000-4000-8000-000000000002",
  optionCount: 3,
  voucherAmount: 55,
  voucherCurrency: "SGD",
  expiresAt: "2026-10-15T09:50:00+08:00",
};

describe("SNS-shaped notification publisher (PRD F-1)", () => {
  it("shapes a PublishInput-like message for the disruption topic", () => {
    const input = buildDisruptionPublishInput(MESSAGE);
    expect(input.TopicArn).toContain("rebook-cancellation");
    expect(input.TopicArn.startsWith("arn:aws:sns:")).toBe(true);
    expect(input.Subject).toContain("NX 288");
    expect(input.MessageAttributes?.["pnrId"]?.StringValue).toBe(MESSAGE.pnrId);
    const parsed = JSON.parse(input.Message) as { default: string; optionCount: number };
    expect(parsed.optionCount).toBe(3);
    expect(parsed.default).toContain("cancelled");
    expect(parsed.default).toContain("voucher");
  });

  it("adapts topic + text for long delays", () => {
    const input = buildDisruptionPublishInput({
      ...MESSAGE,
      disruptionKind: "long_delay",
      delayMinutes: 240,
    });
    expect(input.TopicArn).toContain("rebook-long-delay");
    const parsed = JSON.parse(input.Message) as { default: string };
    expect(parsed.default).toContain("240 minutes");
  });

  it("delivers to the inbox and appends notification.sent", async () => {
    const inserts: { table?: string; values?: Record<string, unknown> }[] = [];
    const ids = ["3f1d2a58-9c0e-4a7a-b1c2-1f6e8f0a9b01", "4f1d2a58-9c0e-4a7a-b1c2-1f6e8f0a9b02"];
    let generated = 0;
    const fakeDb = {
      insert(table: unknown) {
        const tableName =
          (table as { getTableName?: () => string } | undefined)?.getTableName?.() ?? "?";
        return {
          values(values: Record<string, unknown>) {
            return {
              returning: async () => {
                const id = ids[generated] ?? crypto.randomUUID();
                generated += 1;
                inserts.push({ table: tableName, values });
                return [{ id, sequence: 1 }];
              },
            };
          },
        };
      },
    } as unknown as OrchestratorDb;

    const publisher = createInboxNotificationPublisher(fakeDb);
    const input = buildDisruptionPublishInput(MESSAGE);
    const result = await publisher.publish(input);

    expect(result.MessageId).toBe(ids[0]);
    expect(inserts).toHaveLength(2); // inbox row + event_log append
    const inboxRow = inserts[0]?.values ?? {};
    expect(inboxRow["channel"]).toBe("inbox");
    expect(inboxRow["state"]).toBe("delivered");
    expect(inboxRow["deliveredAt"]).toBeInstanceOf(Date);
    const eventRow = inserts[1]?.values ?? {};
    expect(eventRow["type"]).toBe("notification.sent");
    expect(eventPayloadSchemas["notification.sent"].parse(eventRow["payload"])).toMatchObject({
      notificationId: ids[0],
      pnrId: MESSAGE.pnrId,
      channel: "inbox",
    });
  });

  it("rejects publishes without the pnrId attribute (routing requires it)", async () => {
    const broken: SnsPublishInput = {
      TopicArn: "arn:aws:sns:ap-southeast-1:111111111111:rebook-cancellation",
      Message: "{}",
    };
    const fakeDb = {} as OrchestratorDb;
    await expect(createInboxNotificationPublisher(fakeDb).publish(broken)).rejects.toThrow("pnrId");
  });
});
