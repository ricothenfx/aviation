import { Button } from "@aviation/ui";

import { repoRoot } from "@/lib/projects";
import { FlightBoard } from "@/components/flight-board";

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <div aria-hidden className="pl-hero-grid absolute inset-0" />
      <div className="relative mx-auto max-w-6xl px-4 pb-12 pt-16 sm:pt-20">
        <p className="font-mono text-xs uppercase tracking-widest text-accent">
          Singapore · Full-stack TypeScript · Applied AI in aviation operations
        </p>
        <h1 className="mt-4 max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-fg sm:text-4xl">
          Mission control for the ramp, the hangar, and the disrupted passenger.
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-6 text-muted sm:text-base sm:leading-7">
          Three production-shaped aviation systems, built end-to-end in one TypeScript/Next.js
          monorepo: an event-sourced turnaround command center, a citation-gated maintenance RAG
          copilot, and a passenger disruption concierge with saga-backed fulfillment. Every number
          on this page is measured in a committed report — not claimed.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <a href="#systems">
            <Button>Explore the three systems</Button>
          </a>
          <a
            href={repoRoot()}
            className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium text-fg transition-colors duration-150 hover:bg-raised"
          >
            Read the engineering docs
          </a>
        </div>
        <div className="mt-10">
          <FlightBoard />
        </div>
      </div>
    </section>
  );
}
