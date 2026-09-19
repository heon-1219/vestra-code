import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // There is a stray package-lock.json in the user's home directory, above the
  // repo, and Turbopack otherwise walks up to it and warns. Pin the root to
  // this project so the file tracing is unambiguous.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
