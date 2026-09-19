import { sql } from "drizzle-orm";

import { db } from "@/db";

/**
 * Is this process up, and does the database answer?
 *
 * Two facts, reported separately, because they fail separately and the founder
 * will be reading this at the moment something is wrong. "The container booted"
 * and "Neon is reachable from it" are different problems with different fixes,
 * and a single green/red light hides which one he has.
 *
 * Deliberately unauthenticated: Railway's health check arrives with no cookies,
 * and a check that needs a session is a check that reports every deploy as
 * broken. The only thing that costs us is one `select 1` per probe from anyone
 * who finds the URL, which is why the answer carries no detail — `up` or
 * `down`, never a driver message, never a host name, never a timing. A
 * connection error from `pg` names the host and the user, and that is precisely
 * the sort of thing an error page should not be handing out.
 */

export const runtime = "nodejs";
// Asking the database is the entire point; a cached answer would be a lie with
// a timestamp on it.
export const dynamic = "force-dynamic";

/**
 * Long enough that a slow round trip to Singapore is not called a failure,
 * short enough that the platform's own health-check timeout is never the thing
 * that fires. A hung socket is the case this exists for: without a deadline the
 * probe waits as long as the TCP stack does, and Railway restarts a container
 * whose database is merely slow.
 */
const DB_TIMEOUT_MS = 5_000;

async function databaseAnswers(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS);
    });
    await Promise.race([db.execute(sql`select 1`), timeout]);
    return true;
  } catch {
    // Swallowed on purpose. Whatever `pg` wanted to say about the connection
    // string is not for an anonymous caller, and the caller already has the
    // only bit that concerns them.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const database = (await databaseAnswers()) ? "up" : "down";

  /*
   * 200 even when the database is down, and this is the one judgement call in
   * the file.
   *
   * A non-2xx here would fail Railway's health check, which would roll back or
   * restart the container — and restarting this process does nothing about Neon
   * being unreachable. It would turn a database blip into an app outage, and
   * during a deploy it would block a perfectly good build from ever going live.
   * The status code answers "should traffic come here"; the body answers "is
   * everything working". Anything watching for a database outage must read
   * `database`, not the status code.
   */
  return Response.json(
    { status: "ok", database },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
