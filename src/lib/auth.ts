import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";

import { db } from "../db";
import { env } from "./env";

/**
 * Better Auth, configured for GitHub and Google.
 *
 * On GitHub scopes: we deliberately request none beyond the default. The MVP
 * reads public repositories only, which needs no scope — an authenticated
 * token is wanted purely for the rate limit (60/hr anonymous vs 5000/hr), and
 * asking for `repo` to fetch public files would be asking for private-repo
 * access we neither need nor want to hold. Private repos arrive later as a
 * GitHub App, which is the right mechanism for that.
 *
 * Better Auth stores the provider access token on the `account` row. Step 2
 * reads it server-side with `auth.api.getAccessToken({ body: { accountId } })`,
 * where accountId comes from `listAccounts` — a provider name is not a valid
 * selector for that call.
 */
export const auth = betterAuth({
  appName: "Vestra Code",
  database: drizzleAdapter(db, { provider: "pg" }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  socialProviders: {
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },
  // Must stay last: nextCookies() wraps the response to set cookies in Next.js
  // server actions and route handlers.
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
