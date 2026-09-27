"use client";

import { useEffect, useState } from "react";

function timeIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
}

/**
 * Ops-clock: UTC + Singapore local time (ui-design-system.md §3 mono, tabular).
 * Renders a placeholder until mounted — the page is statically exported, so
 * the first paint must not depend on the client clock (no hydration drift).
 */
export function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      className="flex items-center gap-4 font-mono text-xs tabular-nums"
      role="timer"
      aria-label="Current UTC and Singapore time"
    >
      <span className="text-muted">
        <span className="mr-1.5 text-accent">UTC</span>
        <span className="text-fg">{now ? timeIn("UTC", now) : "--:--:--"}</span>
      </span>
      <span aria-hidden className="text-border">
        |
      </span>
      <span className="text-muted">
        <span className="mr-1.5 text-accent">SIN</span>
        <span className="text-fg">{now ? timeIn("Asia/Singapore", now) : "--:--:--"}</span>
      </span>
    </div>
  );
}
