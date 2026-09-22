"use client";

import { useEffect, useRef } from "react";

import type { FlightProjection } from "@aviation/contracts";

/**
 * Turnaround timeline (PRD F-1): Gantt lanes per stand via vis-timeline
 * (tech-stack.md §1 — locked Gantt choice). Client-only (dynamic import inside
 * the effect; vis-timeline touches `window` at construction time).
 */

type TimelineInstance = {
  setItems: (items: unknown) => void;
  setGroups: (groups: unknown) => void;
  on: (event: string, handler: (...args: never[]) => void) => void;
  destroy: () => void;
  redraw: () => void;
};

interface GanttItem {
  id: string;
  group: string;
  content: string;
  start: string;
  end: string;
  className: string;
  title: string;
}

const STATUS_CLASS: Record<FlightProjection["status"], string> = {
  scheduled: "tiq-item-scheduled",
  in_block: "tiq-item-inblock",
  turnaround: "tiq-item-turnaround",
  off_block: "tiq-item-offblock",
  delayed: "tiq-item-delayed",
};

export function TurnaroundGantt({
  flights,
  windowStart,
  windowEnd,
  onSelectFlight,
}: {
  flights: FlightProjection[];
  windowStart: string;
  windowEnd: string;
  onSelectFlight: (flightId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<TimelineInstance | null>(null);
  const selectRef = useRef(onSelectFlight);
  selectRef.current = onSelectFlight;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    void (async () => {
      const [{ Timeline, DataSet }, groupsById] = await Promise.all([
        import("vis-timeline/standalone"),
        Promise.resolve(buildGroups(flights)),
      ]);
      if (disposed || !containerRef.current) return;

      const groups = new DataSet(
        [...groupsById.entries()].map(([id, label]) => ({ id, content: label })),
      );
      const timeline = new Timeline(
        containerRef.current,
        new DataSet(buildItems(flights)),
        groups,
        {
          min: windowStart,
          max: windowEnd,
          zoomMin: 1000 * 60 * 60,
          stack: false,
          showCurrentTime: false,
          selectable: true,
          multiselect: false,
          orientation: { axis: "top", item: "top" },
          margin: { item: { vertical: 4, horizontal: 0 } },
          format: { minorLabels: { hour: "HH:mm" }, majorLabels: { hour: "HH:mm" } },
        },
      ) as unknown as TimelineInstance;
      timeline.on("select", ((...args: unknown[]) => {
        const props = args[0] as { items?: string[] };
        const first = props.items?.[0];
        if (first) selectRef.current(first);
      }) as never);
      timelineRef.current = timeline;
    })();

    return () => {
      disposed = true;
      timelineRef.current?.destroy();
      timelineRef.current = null;
    };
    // The timeline is created once; data updates flow through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    void (async () => {
      const { DataSet } = await import("vis-timeline/standalone");
      timeline.setItems(new DataSet(buildItems(flights)));
      timeline.redraw();
    })();
  }, [flights]);

  return (
    <div
      ref={containerRef}
      data-testid="turnaround-gantt"
      className="tiq-timeline h-full min-h-[240px] w-full"
      aria-label="Turnaround timeline: one lane per stand, one bar per flight"
      role="application"
    />
  );
}

function buildGroups(flights: FlightProjection[]): Map<string, string> {
  const groups = new Map<string, string>();
  for (const flight of [...flights].sort((a, b) => a.standCode.localeCompare(b.standCode))) {
    if (!groups.has(flight.standId)) groups.set(flight.standId, flight.standCode);
  }
  return groups;
}

function buildItems(flights: FlightProjection[]): GanttItem[] {
  return flights.map((flight) => {
    const end =
      flight.status === "off_block"
        ? (flight.estOffBlock ?? flight.schedOffBlock)
        : flight.schedOffBlock;
    const delay = flight.delayedMin > 0 ? ` · +${flight.delayedMin}m` : "";
    return {
      id: flight.id,
      group: flight.standId,
      content: flight.flightNo,
      start: flight.schedInBlock,
      end,
      className: STATUS_CLASS[flight.status],
      title: `${flight.flightNo} · ${flight.status}${delay} · ${flight.standCode}`,
    };
  });
}
