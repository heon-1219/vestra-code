import path from "node:path";

import { defineConfig } from "vitest/config";

// .mts so Vite loads this as ESM. A .ts config is loaded as CommonJS, which
// warns today and becomes an error in a future Vite major.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
