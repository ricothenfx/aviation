import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources (monorepo-architecture.md §1).
  transpilePackages: [
    "@aviation/ui",
    "@aviation/contracts",
    "@aviation/db",
    "@aviation/llm-gateway",
  ],
};

export default nextConfig;
