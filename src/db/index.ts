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
    /*
     * Neon suspends an idle compute and the sockets go with it.
     *
     * The default here is 0, which means "wait for ever". With the compute
     * asleep, requests do not fail — they queue, silently, until ten of them
     * hold all ten clients and every later request waits behind a database
     * that is not answering. Ten seconds is long enough for Neon to wake and
     * short enough that a caller gets an error it can say out loud.
     */
    connectionTimeoutMillis: 10_000,
    /*
     * And a query that hangs must not hold a client for ever, for the same
     * reason: ten hung queries is the whole pool.
     */
    statement_timeout: 120_000,
  });

/*
 * An idle client that dies takes the process with it, unless someone listens.
 *
 * `pg` surfaces a dropped idle socket as an `error` event on the Pool, and an
 * EventEmitter that emits `error` with no listener throws — out of any request,
 * with no stack that points anywhere useful. On a host that suspends its
 * database when nobody is using it, that is not an edge case: it is what
 * happens every night. The app crashes, restarts, and the logs say nothing
 * about why.
 *
 * Logging is the whole handler. `pg` has already removed the dead client from
 * the pool; there is nothing to repair, only something to not die from.
 */
pool.on("error", (error) => {
  console.error("[db] idle client error", error);
});

if (process.env.NODE_ENV !== "production") {
  globalForDb.__vestraPool = pool;
}

export const db = drizzle(pool, { schema });

export type Db = typeof db;
export { pool };
