import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

/**
 * The session for the current request, or null.
 *
 * Section 8 of the brief: every server route checks the session, and checks
 * that the project belongs to the user. Middleware is deliberately not the
 * mechanism — it runs before the request reaches the handler and is easy to
 * bypass with a route that forgets to opt in. Each page and handler asks here.
 */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

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
