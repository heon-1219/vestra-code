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
 * Better Auth refreshes an expired token inside getAccessToken, which is why
 * this goes through the API rather than reading account.accessToken out of our
 * own table directly.
 */
export async function getGithubToken(
  headers: Headers,
): Promise<string | null> {
  try {
    const accounts = await auth.api.listUserAccounts({ headers });
    const github = accounts?.find((account) => account.providerId === "github");
    if (!github) return null;

    // The selector is the account row's own id. A provider name is not a valid
    // selector for this call — the compiler and the docs agree on that, and
    // passing one is the obvious wrong guess.
    const result = await auth.api.getAccessToken({
      body: { accountId: github.id },
      headers,
    });
    return result?.accessToken ?? null;
  } catch {
    // A missing or unrefreshable token is not a failure worth surfacing: we
    // fall back to unauthenticated requests, which work for public repos.
    return null;
  }
}
