import path from "node:path";

import type { NextConfig } from "next";

import { AVATAR_HOSTS } from "./src/lib/avatar-hosts";

const nextConfig: NextConfig = {
  /*
   * Build a self-contained server, because the production image runs it
   * directly.
   *
   * Without this the runtime container would have to carry every installed
   * package to run `next start`, including the compiler and test tooling the
   * app never loads. Tracing the imports instead keeps the image to what the
   * server actually reaches for — see the runner stage in the Dockerfile, which
   * copies `public` and `.next/static` in by hand because a standalone build
   * expects a CDN to serve them and we have none.
   */
  output: "standalone",

  // There is a stray package-lock.json in the user's home directory, above the
  // repo, and Turbopack otherwise walks up to it and warns. Pin the root to
  // this project so the file tracing is unambiguous.
  turbopack: {
    root: path.resolve(__dirname),
  },

  /*
   * Profile pictures, and nothing else.
   *
   * The optimiser will fetch any URL on this list, so the list is the whole
   * security boundary — a wildcard here would turn /_next/image into an open
   * proxy that fetches arbitrary addresses with our server's network position.
   * The hosts come from the same module the avatar component checks against, so
   * a provider cannot be allowed in one place and rejected in the other.
   */
  images: {
    remotePatterns: AVATAR_HOSTS.map((hostname) => ({
      protocol: "https" as const,
      hostname,
    })),
  },
};

export default nextConfig;
