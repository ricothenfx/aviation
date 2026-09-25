import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources (monorepo-architecture.md §1).
  transpilePackages: ["@aviation/ui", "@aviation/contracts"],
  // NEXT_DIST_DIR lets a second, provider-off web instance (FR-12 extractive
  // fallback integration test) build/start into its own directory without
  // clobbering the live .next of the primary compose web container.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
