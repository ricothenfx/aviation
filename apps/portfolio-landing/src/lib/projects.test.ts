import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PROJECTS, TRACEABILITY_PATH, GATES } from "@/lib/projects";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(currentDir, "..", "..", "..", "..");
const APP_ROOT = path.resolve(currentDir, "..", "..");

describe("landing page honesty invariants (ADR-0019, D-07)", () => {
  it("ships exactly the three portfolio projects in locked build order (D-02)", () => {
    expect(PROJECTS.map((p) => p.slug)).toEqual(["turnaround-iq", "mro-copilot", "rebook-ai"]);
    expect(PROJECTS.map((p) => p.buildOrder)).toEqual([1, 2, 3]);
  });

  it("every live project has a verified https demo URL; prepared projects have none", () => {
    for (const project of PROJECTS) {
      if (project.status === "live") {
        expect(project.demoUrl).toMatch(/^https:\/\/[a-z0-9.-]+$/);
        expect(project.liveSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      } else {
        // A prepared project must never render a clickable demo link (honesty).
        expect(project.demoUrl).toBeNull();
        expect(project.liveSince).toBeNull();
      }
    }
    // Guard the other direction: a live URL implies a live status.
    for (const project of PROJECTS) {
      if (project.demoUrl !== null) {
        expect(project.status).toBe("live");
      }
    }
  });

  it("every metric cites a committed report that exists in this repository", () => {
    expect(PROJECTS.flatMap((p) => p.metrics).length).toBeGreaterThanOrEqual(9);
    for (const metric of PROJECTS.flatMap((p) => p.metrics)) {
      expect(metric.value).not.toBe("");
      expect(metric.source).toMatch(/^docs\/.+\.md$/);
      expect(existsSync(path.join(REPO_ROOT, metric.source))).toBe(true);
    }
  });

  it("every screenshot exists in public/ and carries alt text", () => {
    for (const project of PROJECTS) {
      expect(project.screenshot).toMatch(/^\/screenshots\//);
      expect(existsSync(path.join(APP_ROOT, "public", project.screenshot))).toBe(true);
      expect(project.screenshotAlt.length).toBeGreaterThan(10);
    }
  });

  it("case-study and traceability paths point into the public repository docs", () => {
    for (const project of PROJECTS) {
      const repoRelative = project.caseStudy.replace(/^(tree|blob)\/main\//, "");
      expect(existsSync(path.join(REPO_ROOT, repoRelative, "PRD.md"))).toBe(true);
    }
    expect(TRACEABILITY_PATH).toContain("traceability-matrix.md");
  });

  it("every system has a F5 gate verdict citing an existing committed report", () => {
    for (const project of PROJECTS) {
      const gate = GATES[project.slug];
      expect(gate.gate.length).toBeGreaterThan(10);
      expect(gate.result).not.toBe("");
      expect(gate.report).toMatch(/^docs\/.+\.md$/);
      expect(existsSync(path.join(REPO_ROOT, gate.report))).toBe(true);
    }
  });
});
