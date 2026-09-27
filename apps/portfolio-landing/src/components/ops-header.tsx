import { LiveDot } from "@aviation/ui";

import { PROJECTS } from "@/lib/projects";
import { LiveClock } from "@/components/live-clock";

/** Top ops bar: brand, live statuses of the three systems, UTC/SIN clock. */
export function OpsHeader() {
  const liveCount = PROJECTS.filter((p) => p.status === "live").length;
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/95 backdrop-blur-sm">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-4 px-4">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm font-semibold tracking-wide text-fg">
            AVIATION<span className="text-accent">·</span>PORTFOLIO
          </span>
          <span className="hidden text-xs text-muted md:inline">ricothen.com</span>
        </div>
        <div className="flex items-center gap-4">
          <LiveDot
            live={liveCount > 0}
            label={`${liveCount}/${PROJECTS.length} systems live`}
            className="hidden sm:inline-flex"
          />
          <LiveClock />
        </div>
      </div>
    </header>
  );
}
