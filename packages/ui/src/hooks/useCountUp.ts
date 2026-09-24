"use client";

import { useEffect, useRef, useState } from "react";

/**
 * KPI count-up (ui-design-system.md §6: "numbers animate via count-up only on
 * KPI changes"): the first value renders immediately; only target CHANGES
 * animate, eased over `durationMs`. Honors prefers-reduced-motion (§9) by
 * snapping straight to the new value.
 */
export function useCountUp(target: number, durationMs = 500): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = displayRef.current;
    if (from === target) return;

    if (
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = from + (target - from) * eased;
      displayRef.current = value;
      setDisplay(value);
      if (progress < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);

  return display;
}
