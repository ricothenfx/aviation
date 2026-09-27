import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueueDeltaPayload } from "@aviation/contracts";

import {
  createQueueCoalescer,
  QUEUE_FLUSH_MAX_ATTEMPTS,
  QUEUE_FLUSH_MS,
  type QueueFlush,
} from "./queue";

/**
 * Coalesced queue refresh semantics (ADR-0016, D-22 + amendment): N schedules
 * within one window ⇒ ONE rebuild + ONE queue.delta; scheduling is
 * fire-and-forget; a failed flush retries on a later window (bounded) instead
 * of failing the domain event.
 */

const delta = (reason: QueueDeltaPayload["reason"]): QueueDeltaPayload => ({
  waiting: 1,
  containmentPct: 0,
  reason,
});

describe("queue coalescer (ADR-0016)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses N schedules in one window into one flush with the last reason", async () => {
    const flushes: string[] = [];
    const flush: QueueFlush = async (reason) => {
      flushes.push(reason);
      return delta(reason);
    };
    const coalescer = createQueueCoalescer(flush);

    coalescer.schedule("disruption");
    coalescer.schedule("disruption");
    coalescer.schedule("confirm");
    expect(flushes).toEqual([]); // nothing fires before the window elapses

    await vi.advanceTimersByTimeAsync(QUEUE_FLUSH_MS + 1);

    expect(flushes).toEqual(["confirm"]); // one flush, last reason wins
  });

  it("runs one flush per window while callers keep arriving", async () => {
    const flushes: string[] = [];
    const flush: QueueFlush = async (reason) => {
      flushes.push(reason);
      return delta(reason);
    };
    const coalescer = createQueueCoalescer(flush);

    coalescer.schedule("disruption");
    await vi.advanceTimersByTimeAsync(QUEUE_FLUSH_MS + 1);
    expect(flushes).toEqual(["disruption"]);

    // A later caller starts a fresh window and gets its own flush.
    coalescer.schedule("compensation");
    await vi.advanceTimersByTimeAsync(QUEUE_FLUSH_MS + 1);
    expect(flushes).toEqual(["disruption", "compensation"]);
  });

  it("retries a failed flush on a later window and recovers", async () => {
    let failing = true;
    const attempts: QueueDeltaPayload["reason"][] = [];
    const flush: QueueFlush = async (reason) => {
      attempts.push(reason);
      if (failing) throw new Error("rebuild boom");
      return delta(reason);
    };
    const coalescer = createQueueCoalescer(flush);

    coalescer.schedule("disruption");
    // The retry schedule is 2 windows out; advance far enough for the bounded
    // retry to fire.
    await vi.advanceTimersByTimeAsync(QUEUE_FLUSH_MS * 5);
    expect(attempts.length).toBeGreaterThanOrEqual(2); // retried after failure

    failing = false;
    coalescer.schedule("disruption");
    await vi.advanceTimersByTimeAsync(QUEUE_FLUSH_MS + 1);
    // The recovered flush lands on the fresh schedule.
    expect(attempts.at(-1)).toBe("disruption");
  });

  it("stops retrying after the bounded budget and accepts the next schedule", async () => {
    let calls = 0;
    const flush: QueueFlush = async () => {
      calls += 1;
      throw new Error("rebuild boom");
    };
    const coalescer = createQueueCoalescer(flush);

    coalescer.schedule("disruption");
    // 1 initial flush + (budget - 1) retries, then the coalescer waits for a
    // fresh schedule instead of looping forever.
    await vi.advanceTimersByTimeAsync(QUEUE_FLUSH_MS * QUEUE_FLUSH_MAX_ATTEMPTS * 5);
    expect(calls).toBe(QUEUE_FLUSH_MAX_ATTEMPTS);

    coalescer.schedule("confirm");
    await vi.advanceTimersByTimeAsync(QUEUE_FLUSH_MS + 1);
    expect(calls).toBe(QUEUE_FLUSH_MAX_ATTEMPTS + 1); // fresh schedule flushes once
  });
});
