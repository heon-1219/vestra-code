import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { auth } from "@/lib/auth";

/**
 * The session for the current request, or null.
 *
 * Section 8 of the brief: every server route checks the session, and checks
 * that the project belongs to the user. Middleware is deliberately not the
 * mechanism — it runs before the request reaches the handler and is easy to
 * bypass with a route that forgets to opt in. Each page and handler asks here.
 *
 * ## Why this is wrapped in `cache()`
 *
 * Because asking here is cheap to *write* and was not cheap to *run*. Opening
 * one project asked three times for the same row:
 *
 *   - `src/app/app/layout.tsx` — every screen under `/app` is behind a session
 *   - `generateMetadata` in `app/[projectId]/page.tsx` — for the tab title
 *   - `ProjectPage` itself
 *
 * All three run inside one request, and Better Auth's `findSession` is one
 * `session JOIN user` round trip each (verified in
 * `better-auth/dist/db/internal-adapter.mjs` — it joins rather than issuing two
 * queries). Three identical queries to Singapore, on every workspace open, for
 * one row that cannot have changed between them. React's `cache` collapses them
 * to one.
 *
 * **Per request, and only per request.** The memo lives in the cache map React
 * creates for the request being rendered; it is not a store, it has no TTL, and
 * there is no key to get wrong because this function takes no arguments. Two
 * people's requests cannot see each other's entry, which is the only property
 * that matters here — a session cache that crossed requests would hand one user
 * another user's account, and that is the worst failure this codebase has.
 *
 * Outside a React request scope — a route handler on some runtimes — `cache`
 * degrades to calling straight through, which is exactly today's behaviour. So
 * this is a saving where it applies and a no-op where it does not, never a
 * different answer.
 */
export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

/**
 * The session, or a redirect to sign-in. Use in protected pages and layouts.
 */
export async function requireSession() {
  const session = await getSession();
  if (!session) {
    redirect("/sign-in");
  }
  return session;
}
