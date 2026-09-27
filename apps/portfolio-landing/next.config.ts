import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ADR-0019: the landing page is a fully static export (no server runtime,
  // served by Caddy's file_server). Workspace packages ship TypeScript sources.
  output: "export",
  transpilePackages: ["@aviation/ui"],
  images: {
    // Static export has no image-optimization server; plain <img> is used.
    unoptimized: true,
  },
};

export default nextConfig;
