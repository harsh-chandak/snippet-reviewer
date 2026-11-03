import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this folder, so a lockfile higher up the disk isn't picked instead.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
