import { describe, expect, it } from "vitest";

import { queuePriority } from "./queue";

/**
 * Queue priority scoring (PRD F-4): tier + disruption kind + SSR + wait,
 * deterministic and total-ordered (F2 DoD lives with the projection tests;
 * this pins the pure scoring).
 */

describe("queue priority (PRD F-4)", () => {
  it("orders gold cancellation SSR first, then by tier/kind/wait", () => {
    const scores = [
      queuePriority({ tier: "standard", kind: "long_delay", ssr: false, waitMinutes: 0 }),
      queuePriority({ tier: "silver", kind: "long_delay", ssr: false, waitMinutes: 5 }),
      queuePriority({ tier: "silver", kind: "cancellation", ssr: false, waitMinutes: 2 }),
      queuePriority({ tier: "gold", kind: "long_delay", ssr: false, waitMinutes: 1 }),
      queuePriority({ tier: "gold", kind: "cancellation", ssr: false, waitMinutes: 4 }),
      queuePriority({ tier: "gold", kind: "cancellation", ssr: true, waitMinutes: 4 }),
    ];
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1] ?? 0);
    }
  });

  it("caps the wait contribution so age cannot outrank tier+kind", () => {
    const aged = queuePriority({
      tier: "standard",
      kind: "long_delay",
      ssr: false,
      waitMinutes: 5_000,
    });
    expect(aged).toBe(100 + 40 + 240); // wait contribution stops at the cap
    const freshGoldCancellation = queuePriority({
      tier: "gold",
      kind: "cancellation",
      ssr: false,
      waitMinutes: 0,
    });
    expect(freshGoldCancellation).toBeGreaterThan(aged);
  });

  it("is deterministic", () => {
    const item = {
      tier: "silver" as const,
      kind: "cancellation" as const,
      ssr: true,
      waitMinutes: 17,
    };
    expect(queuePriority(item)).toBe(queuePriority(item));
  });
});
