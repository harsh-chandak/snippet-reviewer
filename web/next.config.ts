import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this folder, so a lockfile higher up the disk isn't picked instead.
  outputFileTracingRoot: path.join(__dirname),
  // NEXT_DIST_DIR lets a production build run next to a running dev server without overwriting its .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default nextConfig;
