# Credential rotation, and keeping keys out of git

Written in English like the rest of `docs/`, and written to be followed by
someone who has not done this before. Every step says where to click, what to
change, and what stops working while you are changing it.

## Why this document exists

Four live credentials were pasted into a chat with an AI assistant while this
was being built:

- the Google Gemini API key (`LLM_GEMINI_API_KEY`)
- the Neon Postgres connection string, which contains the database password
  (`DATABASE_URL`, and therefore also `DATABASE_URL_POOLED`)
- the GitHub OAuth App client secret (`GITHUB_CLIENT_SECRET`)
- the Google OAuth client secret (`GOOGLE_CLIENT_SECRET`)

A credential that has left your machine is compromised whether or not anyone
misused it. There is no way to un-send it and no way to find out who read it, so
the only honest response is to replace all four before this is deployed
publicly. That is the first half of this document.

**The good news, established before any of the below: none of these ever
reached git.** Not the working tree, not `HEAD`, not any commit in the history,
not any dangling object. The damage is limited to "rotate these four" and does
not extend to "and the history is public". The commands that establish this are
in [Re-checking the history](#re-checking-the-history) so that anyone can
reproduce the result rather than take it on faith.

---

## Rotate now

Four credentials, in the order that hurts least. Read
[what breaks](#what-breaks-while-you-rotate) before starting the Neon one — it
is the only one with unavoidable downtime.

For all four, the same three places hold the value and all three must end up
agreeing:

| Place | What it is |
|---|---|
| `.env.local` | your machine, for `npm run dev`. Gitignored. |
| Railway → the service → **Variables** | production. See `docs/DEPLOY.md` step 5. |
| The vendor's own console | where the credential is issued |

`.env.example` is a fourth file with the same variable names in it, and it must
stay as it is: names and comments, no values. It is committed.

### 1. Gemini API key — `LLM_GEMINI_API_KEY`

Issued at **aistudio.google.com → API keys** (or, if this key was created
through Google Cloud rather than AI Studio, at **console.cloud.google.com →
APIs & Services → Credentials**, where it appears under API keys).

1. Create a **new** key first. Do not delete the old one yet.
2. Paste the new value into `.env.local`, replacing the old one.
3. Paste it into Railway's Variables tab. Let it redeploy.
4. Confirm the app can still answer a question about a project.
5. Now delete the old key in the console.

**What breaks:** nothing, if you create before you delete. If you delete first,
every LLM pass fails in the window between — and it fails in a way worth
recognising, because it does not look like a missing key. With no key at all,
`src/lib/llm/config.ts` returns null for the provider and the app says it has no
model connected. With a *revoked* key the request still goes out, Google answers
401, and `src/lib/llm/client.ts` turns that into "모델 열쇠가 받아들여지지
않았어요. 설정을 확인해 주세요." If you see that sentence, the key is wrong, not
absent.

Before you delete the old key, look at its usage graph in the console. A spike
you did not cause is worth knowing about.

### 2. GitHub OAuth App client secret — `GITHUB_CLIENT_SECRET`

Issued at **github.com/settings/developers → OAuth Apps →** the app for this
origin. Note that there is one OAuth App per origin: localhost and production
cannot share one, because GitHub allows a single callback URL per app. Rotate
the secret for **each** app whose secret was exposed.

1. Open the app and generate a new client secret. GitHub lets an app hold more
   than one secret at a time, so the old one keeps working while you switch
   over — copy the new value immediately, because it is shown once.
2. Put it in `.env.local` and in Railway's Variables tab. Let it redeploy.
3. Sign out and sign in again with GitHub to prove the new secret works.
4. Delete the old secret in the GitHub console.

`GITHUB_CLIENT_ID` does not change and is not a secret — it is sent to the
browser during sign-in by design.

**What breaks:** nobody is signed out. Sessions in this app are Better Auth's
own, stored in our database and signed by `BETTER_AUTH_SECRET`; the OAuth client
secret is used only when someone signs in and when a GitHub access token is
refreshed. So the cost of a wrong secret is that **new sign-ins fail** until the
app has the new value.

Token refresh is the second, quieter consequence. `src/lib/github/token.ts`
calls Better Auth's `getAccessToken`, which refreshes an expired GitHub token;
with a stale client secret that refresh fails. The code then falls back to the
stored token rather than returning null, so the repository picker keeps working
— you will see `[github] could not refresh the token; trying the stored one` in
the server log before you see any user-visible failure. Treat that line
appearing in bulk as the signal that the secret is out of date somewhere.

### 3. Google OAuth client secret — `GOOGLE_CLIENT_SECRET`

Issued at **console.cloud.google.com → APIs & Services → Credentials →** the
OAuth 2.0 Client ID for this app (type: Web application).

1. Open the client and add a new secret. Copy it.
2. Put it in `.env.local` and in Railway's Variables tab. Let it redeploy.
3. Sign out and sign in again with Google.
4. Delete the old secret.

Unlike GitHub, Google accepts several authorised redirect URIs on one client, so
localhost and production may be sharing a single client. If they are, rotating
once covers both — and both must be updated at the same time, because there is
only one secret between them.

`GOOGLE_CLIENT_ID` does not change and is not a secret.

**What breaks:** the same shape as GitHub. No one is signed out; new sign-ins
with Google fail until every place that holds the secret has the new value.

### 4. Neon Postgres password — `DATABASE_URL` and `DATABASE_URL_POOLED`

This is the one with real downtime. Read the whole step before starting it.

Issued at **the Neon dashboard → your project → Roles**, where the role used by
this connection string has a **Reset password** action.

**Both variables contain the same password.** `DATABASE_URL` is the direct,
unpooled string that the app actually reads; `DATABASE_URL_POOLED` is Neon's
pooled string, kept in the environment because a future serverless path would
need it (DECISIONS D13). Nothing reads the pooled one today, but it holds the
same secret, and an out-of-date copy sitting in a file is exactly how an old
password survives a rotation. Replace both.

1. Have both replacement strings ready to paste before you reset anything. Neon
   shows the new connection string once, after the reset.
2. Reset the password in the Neon dashboard. **The old password stops working
   immediately** — there is no overlap window, which is why this step has
   downtime and the others do not.
3. Copy the new direct (unpooled) string into `DATABASE_URL` and the new pooled
   string into `DATABASE_URL_POOLED`, in **both** `.env.local` and Railway's
   Variables tab.
4. Keep `sslmode=verify-full` on the direct string rather than the `require`
   that Neon may hand you (DECISIONS D58).
5. Let Railway redeploy and watch the deploy logs.

**What breaks:** everything, between the reset and the redeploy finishing. Every
page that touches the database fails, which is every page behind sign-in. The
pool in `src/db/index.ts` will surface dead connections as
`[db] idle client error` in the log. Nobody is signed out — session cookies are
signed by `BETTER_AUTH_SECRET`, which is unchanged — but nobody can do anything
either, because the session rows are in the database that is refusing
connections. Do this at a quiet moment and expect a few minutes.

While you are in the Neon dashboard, look at the connection or query history for
activity you did not cause.

### Not on this list, and deliberately: `BETTER_AUTH_SECRET`

It was not pasted into a chat, so it is not compromised, and it should be left
alone. Changing it signs every user out at once — it is the key that signs the
session cookies, so every cookie in existence becomes unreadable the moment it
changes. Rotate it only if you have reason to believe it leaked, and if you do,
accept the sign-out as the cost rather than being surprised by it.

The same applies to `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` if you ever set it: it
is compiled in at build time, and changing it makes open tabs fail with "Failed
to find Server Action".

### What breaks while you rotate

| Credential | Signed-out users? | What fails, and for how long |
|---|---|---|
| Gemini API key | no | nothing, if you create the new key before deleting the old |
| GitHub client secret | no | new GitHub sign-ins, until every copy is updated. Token refresh degrades quietly to the stored token. |
| Google client secret | no | new Google sign-ins, until every copy is updated |
| Neon password | no | **everything**, from the moment of the reset until the redeploy finishes |
| `BETTER_AUTH_SECRET` (not being rotated) | **yes, everyone** | — |

### After all four

- `npm run dev` and sign in with both GitHub and Google.
- Analyse a project and ask it a question, which exercises the database and the
  model key together.
- Check the deployed app the same way.
- Delete the old credentials in all four consoles, if you have not already.
- Delete any local backup copies of `.env.local` you made while doing this. A
  file named `.env.local.bak` is gitignored by the rules below, but the tidiest
  place for an old secret is nowhere.

---

## Keep it from recurring

### The rule

**A key goes into `.env.local` by hand, and never through a chat window.**

Not into a prompt, not into a pasted error message, not into a code block "just
to show the format", not into a bug report. If a tool or an assistant needs to
know that a key exists, it can be told the variable name — the names are all in
`.env.example`, which is why that file is committed and full of comments. If a
tool needs to *use* the key, point it at `.env.local`; it can read the file
itself.

The reason this rule is absolute rather than a judgement call is that there is
no such thing as un-sending. Every other mistake in this codebase can be fixed
by editing a file. This one cannot.

Two corollaries worth naming, because they are how it happens in practice:

- **Error messages carry secrets.** A pasted stack trace from a failed database
  connection can contain the connection string. Read what you are pasting.
- **"Only the first few characters" is still a leak.** A prefix narrows a
  brute-force search, and some providers accept a key prefix as an identifier.
  If a fragment must be shared at all, four characters is the ceiling.

### The ignore rules, and what they actually do

`.gitignore` ends with:

```
# env files (can opt-in for committing if needed)
.env*
...
!.env.example
```

The `.env*` line catches every variant — `.env`, `.env.local`, `.env.production`,
`.env.local.bak`, `.env.backup` — and the negation at the end lets exactly one
file back through. The order matters: a negation only works if it comes after
the pattern it is undoing.

`.dockerignore` does the same job for the build context with `.env` and
`.env.*`, and there the reasoning is stronger than tidiness: Next loads
`.env.local` automatically during `next build`, so a copy of it inside the build
context would bake the real credentials into an image layer *and* silently build
against the production database.

Verify both at any time, rather than reading the file and hoping:

```bash
# Every variant that holds real values must print the filename (= ignored).
git check-ignore -v .env .env.local .env.production .env.local.bak .env.backup

# And the one that must NOT be ignored should print nothing and exit 1.
git check-ignore -v .env.example; echo "exit $?"   # expect: exit 1
```

As of this audit: all variants ignored, `.env.example` not ignored. Correct.

### `.env.example` holds names, never values

It is committed, which makes it the classic place a real key gets left behind.
It currently holds 23 variables, of which 21 have empty values and two hold
obvious placeholders — the literal string `user:password@host.neon.tech/dbname`
and `http://localhost:3000`. That is the state to keep it in.

When you add a variable, add it here as `NAME=""` with a comment saying where
the value comes from. Never paste a working value in "temporarily".

```bash
# Every value in .env.example, by length. Anything non-zero that is not one of
# the two known placeholders wants a second look.
grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env.example |
  while IFS= read -r line; do n="${line%%=*}"; v="${line#*=}"; v="${v%\"}"; v="${v#\"}";
  printf '%-40s len=%s\n' "$n" "${#v}"; done
```

### Before the first public push

Run the history scan in the next section. It takes under a minute, and it is the
difference between "rotate four credentials" and "rewrite the history and
rotate four credentials". Run it again any time a commit felt rushed.

---

## Re-checking the history

These are the commands this audit ran. All of them are read-only. Run them from
the repository root.

**1. Did any `.env` file ever exist in any commit, on any branch?**

```bash
git log --all --full-history --name-status -- '*.env' '*.env.*' '.env' '.env.*'
```

Expected: hits on `.env.example` only.

**2. Every path that has ever existed, filtered to anything secret-shaped.**

Catches a file committed once under a name you would not have thought to check.

```bash
git log --all --pretty=format: --name-only --full-history | sort -u |
  grep -Ei '(^|/)\.?env|secret|credential|\.pem$|\.key$|\.p12$|id_rsa'
```

Expected: `.env.example` and `src/lib/env.ts`.

**3. Content search across every commit, for credential shapes.**

Searching for the *shape* rather than for a value means it works without having
the secrets to hand, and it keeps working for keys issued in future.

```bash
git grep -I -n -E 'AIza|AQ\.|gh[pous]_|github_pat_|postgres(ql)?://|BETTER_AUTH_SECRET=.' \
  $(git rev-list --all) -- . ':(exclude)package-lock.json'
```

Expected hits, all benign: the `postgresql://user:password@host.neon.tech/dbname`
placeholder in `.env.example`, the build-stage placeholders in the `Dockerfile`,
and the fake token `gho_abc` in `src/lib/github/*.test.ts`.

**4. Every blob in the object database, reachable or not.**

This is the thorough one, and the only one that catches a secret committed and
then amended or rebased away — the object survives inside `.git` until it is
garbage collected, and `git log` will not show it.

```bash
git cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)' |
  awk '$2=="blob" {print $1}' |
  while read -r o; do
    git cat-file blob "$o" | grep -a -n -E \
      'AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z_-]{20,}|gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{50,}|postgres(ql)?://[^:/@[:space:]]+:[^@[:space:]]{6,}@' |
      sed "s|^|$o:|"
  done
```

Expected: the `.env.example` placeholder line and nothing else. This audit ran it
across all 522 blobs in the object database and found nothing else.

**5. Dangling and unreachable commits.**

```bash
git fsck --lost-found --unreachable --dangling
```

One unreachable commit exists (`1234657`, an earlier version of the folder-upload
work). It was checked with the same patterns and contains only the same
placeholders.

**6. The working tree, tracked and untracked.**

```bash
git ls-files -z | xargs -0 grep -a -n -E \
  'AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[0-9A-Za-z]{30,}|postgres(ql)?://[^:/@[:space:]]+:[^@[:space:]]{6,}@'

git ls-files -z --others --exclude-standard | xargs -0 grep -a -l -E \
  'AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[0-9A-Za-z]{30,}|postgres(ql)?://[^:/@[:space:]]+:[^@[:space:]]{6,}@'
```

Expected: the `.env.example` placeholder, and nothing from the untracked set.

### If a scan ever does find something

Rotate first and rewrite second, in that order and without pausing to think
about the order. A rewritten history does not help if the key is still valid,
and a rotated key makes the history embarrassing rather than dangerous. Then:

- If the commit has **not** been pushed, rewriting is local and cheap.
- If it **has** been pushed, assume it is public. Rotate, then rewrite with
  `git filter-repo` (not `filter-branch`), then force-push, then ask GitHub
  Support to expire the cached view of the old objects — a commit stays
  reachable by its SHA through the web interface after a force-push until they
  do.

---

## What the code does with secrets at runtime

Checked during this audit, and worth keeping true.

- **Nothing secret reaches the browser.** There are no `NEXT_PUBLIC_` variables
  anywhere, and no `process.env` read in any file marked `"use client"`.
  `process.env` is read in exactly three places in `src/`: the schema parse in
  `src/lib/env.ts`, the `NODE_ENV` check in `src/db/index.ts`, and a comment.
- **The model panel gets capabilities, not credentials.**
  `availableProviders()` in `src/lib/llm/index.ts` returns `{ id, label, effort }`
  per provider. The API key and base URL stay on the server.
- **Startup validation names variables, never values.** When `src/lib/env.ts`
  fails it prints the variable name and a remedy. Keep it that way: in
  development that message goes to the browser's error overlay.
- **Remote response bodies stay out of user-facing messages.**
  `src/lib/llm/client.ts` reads the error body for the log only and maps the
  status to a fixed sentence; it also throws away the cause of a network failure
  on purpose, because that message can contain the URL and the URL sits next to
  the key. `src/lib/github/api.ts` maps every failure through the fixed
  `GITHUB_MESSAGES` table. The two API routes that return a `message` to the
  browser return an app-authored one, not `error.message`.

Two places to watch rather than fix:

- `src/lib/llm/client.ts` logs up to 500 characters of the provider's error body
  to the server log. Its own comment notes that providers sometimes include a
  prefix of the key there. That is a server log, not a user-facing message, so
  the exposure is limited to whoever can read Railway's logs — but it is a
  reason not to paste raw server logs into a chat window.
- `src/lib/github/token.ts` logs the whole error object when a token refresh
  fails. Whether that object can carry the OAuth client secret depends on what
  Better Auth puts in it, which we do not control. Same conclusion: fine on the
  server, not something to paste elsewhere.

---

## Marked to verify

Written from the codebase and from each vendor's documented behaviour, not from
a rotation that has been performed. The console layouts in particular move:

- Whether the Gemini key lives in AI Studio or in Google Cloud depends on where
  it was created. Check both if it is not where you expect.
- Whether Google's OAuth client console currently offers *adding* a second
  secret or only *replacing* the one. If it only replaces, that credential gains
  a short window where new Google sign-ins fail, and it should be treated like
  the Neon step rather than the GitHub one.
- Neon's exact path to resetting a role password, and whether it offers the
  pooled and direct strings together after the reset.

Correct this file the first time someone runs the steps for real.
