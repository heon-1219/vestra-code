import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { account } from "@/db/schema";
import { auth } from "@/lib/auth";

/**
 * The signed-in user's GitHub token, when they have one.
 *
 * Why bother: unauthenticated GitHub API calls are limited to 60 an hour per
 * IP, which one person analysing two repositories can exhaust, and on a shared
 * host that limit is shared by everyone. An authenticated call gets 5000.
 *
 * Returning null is a completely normal outcome, not an error — a user who
 * signed in with Google has no GitHub account linked, and public repositories
 * are readable without a token. The caller degrades rather than failing.
 *
 * ## Refresh first, but GitHub has the last word
 *
 * Better Auth refreshes an expired token inside `getAccessToken`, which is why
 * the happy path goes through the API rather than reading `access_token` out of
 * our own table. When that refresh fails we fall back to the stored token
 * anyway, and that is deliberate rather than sloppy:
 *
 * **Our `access_token_expires_at` is a copy of something GitHub told us once.
 * GitHub is the authority on whether a token still works.** A real case, found
 * on a live account: the column said the token had expired three hours earlier,
 * the refresh did not succeed, and the very same token answered `GET /user` and
 * `GET /user/repos` with a 200 and twenty-one repositories. Discarding it meant
 * the picker told someone with twenty-one repositories that they had none.
 *
 * So the order is: refresh, then the stored token, then null. If the stored one
 * really is dead GitHub answers 401 and `api.ts` maps that to something we can
 * say out loud — one wasted request, and the failure lands where it can be
 * described instead of here where it cannot.
 *
 * The reason a refresh failed is logged rather than swallowed. The previous
 * version caught everything and returned null, so the difference between "this
 * person never linked GitHub" and "the refresh is broken for everybody" was
 * invisible on the server and identical on screen.
 */
export async function getGithubToken(
  headers: Headers,
): Promise<string | null> {
  let accountId: string | null = null;

  try {
    const accounts = await auth.api.listUserAccounts({ headers });
    const github = accounts?.find((item) => item.providerId === "github");
    // Not an error, and the overwhelmingly common one: signed in with Google.
    if (!github) return null;
    accountId = github.id;

    // The selector is the account row's own id. A provider name is not a valid
    // selector for this call — the compiler and the docs agree on that, and
    // passing one is the obvious wrong guess.
    const result = await auth.api.getAccessToken({
      body: { accountId: github.id },
      headers,
    });
    if (result?.accessToken) return result.accessToken;
    console.warn("[github] refresh returned no token; trying the stored one");
  } catch (error) {
    console.warn("[github] could not refresh the token; trying the stored one", error);
  }

  if (!accountId) return null;
  return storedToken(accountId);
}

/**
 * What we last wrote down, expiry ignored on purpose.
 *
 * Read straight from the table because this is the fallback for the API path
 * having failed, and the API path is the thing that consults the expiry.
 */
async function storedToken(accountId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ accessToken: account.accessToken })
      .from(account)
      .where(and(eq(account.id, accountId), eq(account.providerId, "github")))
      .limit(1);
    return row?.accessToken ?? null;
  } catch (error) {
    console.error("[github] could not read the stored token", error);
    return null;
  }
}
