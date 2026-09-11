import type { NextConfig } from "next";

// Pin the workspace root, or a lockfile further up the tree pulls that
// directory into file tracing.
const projectRoot = process.cwd();

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server.js, used by the Dockerfile.
  output: "standalone",
  outputFileTracingRoot: projectRoot,
  turbopack: { root: projectRoot },
};

export default nextConfig;
