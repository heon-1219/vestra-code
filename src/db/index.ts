import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { env } from "../lib/env";
import * as schema from "./schema";

/**
 * One connection pool per process.
 *
 * We deploy to a persistent Node host (DECISIONS D3), so a long-lived pool is
 * the right shape: the analysis pipeline writes thousands of rows per run, and
 * a per-query HTTP driver is the worst case for that. Neon speaks standard
 * Postgres, so `pg` costs us nothing.
 *
 * Next.js reloads modules on every edit in dev, which would leak a new pool per
 * reload and exhaust Neon's connection limit. Caching on globalThis survives the
 * reload; in production this is a plain module-level singleton.
 */
const globalForDb = globalThis as unknown as { __vestraPool?: Pool };

const pool =
  globalForDb.__vestraPool ??
  new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__vestraPool = pool;
}

export const db = drizzle(pool, { schema });

export type Db = typeof db;
export { pool };
