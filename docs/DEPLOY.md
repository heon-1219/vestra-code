# Deploying Vestra Code to Railway

Written in English, like the rest of `docs/`, and written for someone who has
never deployed a server before. Every step says what to click, what to paste,
and what you should see when it worked.

**Nobody has run these steps end to end yet.** They were written from the
codebase and from Railway's documented behaviour, not from a deployment that
happened. Where I could not be certain of a Railway detail, it says so and is
listed again under [Marked to verify](#marked-to-verify). Treat the first deploy
as the test.

Roughly 40 minutes, most of it waiting for builds and filling in consoles.

---

## What you are deploying

One long-lived Node process in a container, running a Next.js server, talking to
Neon over the internet. Not serverless — that was decided in `DECISIONS.md` D3,
because a full analysis run is a tarball download plus a parse of hundreds of
files plus an LLM pass, and a serverless request cap cuts that off partway.

Three pieces have to agree with each other, and almost every first-deploy
failure is two of them disagreeing:

| Piece | Lives where | Must say |
|---|---|---|
| The app's own origin | `BETTER_AUTH_URL` on Railway | `https://your-app.up.railway.app` |
| GitHub's callback | github.com OAuth App settings | `https://your-app.up.railway.app/api/auth/callback/github` |
| Google's redirect | console.cloud.google.com credentials | `https://your-app.up.railway.app/api/auth/callback/google` |

Steps 6 to 8 are those three, in that order, and they are the part to slow down
for.

---

## Before you start

You need:

- The repo pushed to GitHub.
- A Railway account (railway.com), signed in with GitHub.
- Your Neon project, with the connection string to hand.
- `.env.local` on your machine, working, with real values in it. You will copy
  most of it to Railway and change three things.

---

## 1. Run the migrations against production first

Do this **before** the first deploy. The app does not create its own tables; if
they are missing, every page that touches the database fails, and the failure
looks like a broken deploy rather than an empty database.

Migrations run **from your machine**, not from the container. Two reasons: the
production image contains no `drizzle-kit` (it is a dev dependency, and the
standalone build leaves it out), and a migration that ran at container start
would race itself the moment there were two containers.

Decide first whether production and development share a database. If they do,
your local `.env.local` already points at it, there is nothing to switch, and
you can just run `npm run db:migrate`. If production is a separate Neon project
or branch — which is the better arrangement, because a bad local migration then
cannot touch real users — do this:

1. Open `.env.local`.
2. Copy your **development** `DATABASE_URL` line somewhere safe.
3. Replace it with the **production** connection string from Neon.
4. Run:

   ```
   npm run db:migrate
   ```

5. Put the development line back. Do not skip this; a forgotten production URL
   in `.env.local` means the next thing you run locally writes to production.

You should see drizzle-kit report the migrations it applied. There are three in
`drizzle/` today (`0000_`, `0001_`, `0002_`). Running it twice is safe — the
second run applies nothing.

> Why not a shell variable instead of editing the file? `drizzle.config.ts`
> loads `.env.local` through `dotenv`, which by documented default does not
> overwrite a variable already set in the shell — so `$env:DATABASE_URL="..."`
> before the command should also work in PowerShell. It is the second-best
> option here because "should" is not good enough when the failure mode is
> migrating the wrong database silently. There is a small config change at the
> end of this file that makes the shell-variable route reliable.

**From now on:** run migrations this way *before* deploying code that needs
them. New columns arrive first, the code that reads them arrives second. In the
other order the running app queries a column that does not exist yet.

---

## 2. Create the Railway project

1. Go to railway.com and sign in with GitHub.
2. **New Project** → **Deploy from GitHub repo**.
3. Authorise Railway for the repository if it asks, and pick this repo.

Railway will start building immediately. **Let this first build fail.** It has
no environment variables yet, and the build cannot succeed without them — you
will see it stop with `Environment is not configured`, listing the variables it
wants. That message is the app working correctly.

`railway.json` in the repo root tells Railway to build with the `Dockerfile`
rather than guessing at the stack, and where the health check lives. You should
not have to configure the builder by hand.

---

## 3. Set the region to Singapore

The database is in Neon's `aws-ap-southeast-1` (DECISIONS D24 — Neon has no
Seoul region). A single page load makes several database round trips, so the
distance from the app to the database matters far more than the distance from
your browser to the app. Seoul to Singapore for the browser hop is around 70 ms
and you will not feel it.

In the service's **Settings**, find the region setting and choose Singapore.

> Marked to verify: where exactly this lives in the current Railway interface,
> and whether changing it after the first deploy requires a redeploy.

---

## 4. Generate the two secrets

On your machine (Git Bash, or WSL, or anywhere with `openssl`):

```
openssl rand -base64 32
```

Run it **twice** and keep both lines. The first is `BETTER_AUTH_SECRET`. The
second is `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, explained in step 5.

Do not reuse your local `BETTER_AUTH_SECRET`. It is the key that signs session
cookies, and a development machine is not where a production signing key should
also live.

---

## 5. Set the variables

Open the service → **Variables** tab. Add each of these. `.env.example` in the
repo root is the same list with the same notes, and is the file to check against
if this one ever falls behind.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's **direct** (unpooled) connection string, ending in `?sslmode=verify-full` |
| `BETTER_AUTH_SECRET` | the first `openssl` line from step 4 |
| `BETTER_AUTH_URL` | `http://localhost:3000` for now — step 6 replaces it |
| `GITHUB_CLIENT_ID` | from step 7; for now paste anything non-empty |
| `GITHUB_CLIENT_SECRET` | same |
| `GOOGLE_CLIENT_ID` | from step 8; for now paste anything non-empty |
| `GOOGLE_CLIENT_SECRET` | same |
| `LLM_BASE_URL` | `https://api.xiaomimimo.com/v1` |
| `LLM_API_KEY` | your key |
| `LLM_MODEL` | `mimo-v2.5` |

The placeholders for the four OAuth values are there because the app refuses to
start without them, and you cannot fill them in properly until you have a
domain, which you do not have until it starts. Step 6 breaks that circle.

Notes on three of them:

- **`DATABASE_URL` — the direct string, not the pooled one.** This app holds its
  own connection pool inside a long-lived process, so routing through Neon's
  PgBouncer adds a hop and buys nothing (D13). Keep `sslmode=verify-full`; `pg`
  is changing what the weaker `require` means in its next major version, and
  writing the strong mode explicitly keeps today's behaviour (D58).
- **`BETTER_AUTH_URL` has no trailing slash.** `https://x.up.railway.app`, not
  `https://x.up.railway.app/`. Better Auth glues the callback path onto it, and
  a trailing slash produces `...app//api/auth/callback/github`, which will not
  match what you registered with GitHub.
- **Do not set `PORT`.** Railway supplies it and the server listens on whatever
  it supplies. Pinning your own value is a good way to end up with a health
  check knocking on a port nothing is listening on.

`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is a special case. It has to be present
**when the image is built**, not when it runs — Next compiles it into the build
output. The `Dockerfile` accepts it as a build argument for that reason. As long
as you run **one instance** and reload the page after a deploy, you can leave it
out entirely; it starts mattering when you scale to two instances, or when
someone leaves a tab open across a deploy and then clicks something. The symptom
if it bites is `Failed to find Server Action`.

> Marked to verify: whether Railway passes service variables through to Docker
> `ARG`s automatically, or whether the build argument has to be declared
> somewhere separately. If you never scale past one instance you can ignore this
> entirely.

---

## 6. First real deploy, and getting the URL

1. Trigger a redeploy (the **Deploy** button, or just push a commit).
2. Watch the build log. It should end with the Next build summary and then the
   container starting.
3. Service → **Settings** → **Networking** → **Generate Domain**. Railway gives
   you something like `vestra-code-production.up.railway.app`.
4. Copy that domain. Go back to **Variables** and set:

   ```
   BETTER_AUTH_URL=https://vestra-code-production.up.railway.app
   ```

   with your real domain, `https://`, and no trailing slash.
5. Let it redeploy.

**Check it:**

```
curl https://your-domain.up.railway.app/api/health
```

You want:

```json
{"status":"ok","database":"up"}
```

`"database":"down"` means the process is fine and Neon is not answering it —
check `DATABASE_URL`, and check that Neon has not auto-suspended the project.
The endpoint returns HTTP 200 either way, on purpose: restarting the container
does nothing about a database being unreachable, and a health check that failed
on it would turn a Neon blip into an app outage, and would block a perfectly
good build from going live.

If you later move the app to your own domain, `BETTER_AUTH_URL` changes to that
domain and steps 7 and 8 have to be redone with the new callback URLs. This is
the single most common way a working sign-in breaks later.

---

## 7. GitHub OAuth App

You need a **separate OAuth App from your development one**. GitHub allows one
callback URL per app, so localhost and production cannot share.

1. github.com → your avatar → **Settings** → **Developer settings** →
   **OAuth Apps** → **New OAuth App**.
2. Fill in:
   - **Application name**: `Vestra Code`
   - **Homepage URL**: `https://your-domain.up.railway.app`
   - **Authorization callback URL**:

     ```
     https://your-domain.up.railway.app/api/auth/callback/github
     ```

     Exactly that: `https`, your real domain, no trailing slash, and the path
     spelled `/api/auth/callback/github`.
3. **Register application**.
4. Copy the **Client ID**. Click **Generate a new client secret** and copy that
   too — GitHub shows a secret once and never again.
5. Paste both into Railway's Variables as `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`, replacing the placeholders. Let it redeploy.

There are no scopes to configure. The app deliberately requests none: it reads
public repositories only, and an authenticated token is wanted purely for the
rate limit (60/hr anonymous versus 5000/hr). The reasoning is at the top of
`src/lib/auth.ts`.

---

## 8. Google OAuth client

Google accepts several redirect URIs on one client, so you may add production to
the client you already use for development rather than making a new one.

1. console.cloud.google.com → your project → **APIs & Services** →
   **Credentials**.
2. Either open your existing **OAuth 2.0 Client ID**, or **Create Credentials**
   → **OAuth client ID** → Application type **Web application**.
3. Under **Authorized redirect URIs**, click **Add URI** and paste:

   ```
   https://your-domain.up.railway.app/api/auth/callback/google
   ```

   Keep the localhost one alongside it if it is already there.
4. **Save**. Copy the **Client ID** and **Client secret**.
5. Paste them into Railway as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Two things catch people here:

- **Authorized redirect URIs**, not *Authorized JavaScript origins*. The origins
  box takes `https://your-domain.up.railway.app` with no path; the redirect box
  takes the full callback URL. Putting the callback in the wrong box produces
  `redirect_uri_mismatch` at sign-in.
- If the **OAuth consent screen** is in *Testing* mode, only the accounts listed
  as test users can sign in. Everyone else is refused, which reads as "the app is
  broken". Either add the accounts as test users, or publish the consent screen.

---

## 9. Check that it actually works

In order, because each step tells you something the one before it does not:

1. **`curl https://your-domain/api/health`** → `{"status":"ok","database":"up"}`.
   The process is up and Neon answers it.
2. **Open the site.** The landing page renders. It needs no database and no
   auth, so it working while the rest does not points at environment variables.
3. **Sign in with GitHub.** You should bounce to github.com, approve, and land
   back on `/app`. If you land on an error page instead, the callback URL and
   `BETTER_AUTH_URL` disagree — read the URL in the address bar, it usually
   names the mismatch.
4. **Sign in with Google**, in a private window.
5. **Add a public repository and run an analysis.** This is the one that
   exercises what a container can break: downloading a tarball, unpacking it
   into the container's temp directory, parsing it, and streaming progress over
   SSE for minutes. Watch the progress keep moving.
6. **Refresh the page mid-run.** Progress should pick up where it was. That is
   the SSE reconnect working, and it is the part Railway's request limits bear
   on (D17: 15 minutes maximum per request, closed after 5 minutes of silence,
   which is why the stream sends a heartbeat every 20 seconds and closes itself
   at 14 minutes).

If step 5 fails while steps 1 to 4 passed, the likeliest cause is the parser: it
runs TypeScript analysis at runtime, and if the standalone build failed to trace
one of its files it would fail only here. The fix would be an
`outputFileTracingIncludes` entry in `next.config.ts` for `ts-morph`. It was
deliberately not added pre-emptively — trace includes that are not needed make
the image bigger for nothing, and this is easy to diagnose from the error.

---

## 10. Deploying again, later

Push to `main`. Railway rebuilds and redeploys.

The only thing that needs thought is a schema change: **run the migration from
your machine first** (step 1), then push. Additive changes — new tables, new
nullable columns — are safe in that order. A destructive change (dropping or
renaming a column the running app still reads) needs the old code gone first,
which means two deploys: ship the code that stops using the column, then drop
it.

---

## Troubleshooting

| What you see | What it is |
|---|---|
| Build fails with `Environment is not configured`, listing variables | A required variable is missing from the Variables tab. The message names each one. |
| Deploy succeeds, health check fails, container restarts in a loop | The server is not reachable on Railway's port. `HOSTNAME` must be `0.0.0.0` — the Dockerfile sets it — and `PORT` must not be pinned by hand. |
| `{"status":"ok","database":"down"}` | Process fine, Neon not answering. Check `DATABASE_URL`, and check whether the Neon project auto-suspended. |
| Sign-in goes to GitHub and comes back to an error | The callback URL registered at GitHub does not match `{BETTER_AUTH_URL}/api/auth/callback/github`. Compare them character by character: trailing slash, `http` vs `https`. |
| `redirect_uri_mismatch` from Google | The same mismatch for Google, or the URL went into *Authorized JavaScript origins* instead of *Authorized redirect URIs*. |
| Google says the app is unverified, or refuses the account | The consent screen is in Testing mode. Add the account as a test user, or publish it. |
| Signed in, then signed out again on the next page | `BETTER_AUTH_SECRET` changed between deploys, so every existing session cookie is now unreadable. Sign in again, and do not change that value casually. |
| `Failed to find Server Action` | A build mismatch: an old tab against a new deploy, or two instances built separately. Reloading the page clears it. To prevent it, see `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` in step 5. |
| Analysis starts, then stops with nothing for a long time | Check Railway's logs for the container being killed. A run holds a parsed project in memory, so the plan's memory limit is what to look at. |
| A relation or column does not exist | A migration did not run against production. Step 1. |

---

## Marked to verify

Things I could not confirm, and did not want to state as fact:

1. **Where the region setting lives** in the current Railway interface, and
   whether changing it after a deploy needs a redeploy.
2. **Whether Railway forwards service variables to Docker build `ARG`s.** Only
   affects `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, and only past one instance.
3. **The `railway.json` schema URL** (`https://railway.com/railway.schema.json`)
   and the exact spelling of the keys inside it. If Railway rejects the file or
   quietly ignores it, the same two settings — build with the Dockerfile, health
   check on `/api/health` — can be set in the service's Settings tab instead,
   and the file deleted.
4. **Whether the generated domain is available before the first successful
   deploy.** Step 6 assumes it is not, and takes the slower route. If the
   **Generate Domain** button is there earlier, use it earlier and set
   `BETTER_AUTH_URL` correctly the first time.
5. **Railway's per-plan memory limit** against what an analysis run actually
   uses. Unmeasured. If runs on large repositories die with nothing in the app's
   own logs, this is the first thing to check.

---

## Why `railway.json` and not `railway.toml`

Railway reads either. JSON was chosen because it can carry a `$schema` line that
editors use to validate the file and autocomplete its keys — which matters
precisely because this is a file nobody edits often enough to remember the
spelling of. TOML has no equivalent here. The cost is that JSON cannot hold
comments, so the reasoning lives in this file instead of in that one.

---

## A change worth making to `drizzle.config.ts`

Not made here, because that file was outside this task's scope. It would turn
step 1's file-editing dance into a one-liner:

```ts
// Let an explicitly-set DATABASE_URL win, so a production migration is
// `DATABASE_URL=... npm run db:migrate` rather than an edit to .env.local that
// somebody forgets to undo.
if (!process.env.DATABASE_URL) {
  config({ path: ".env.local" });
}
```
