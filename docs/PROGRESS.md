# Progress

What works, what is mocked, what is next. Updated at every checkpoint.
**Nothing in this file is described as working unless it has been run and checked.**

## Status: Step 3's workspace is built and reaches Step 2's engine. Step 4 has not started.

**441 tests pass** (24 files) at the time of writing — the count moves through today,
because three agents are landing work in this tree at once. 17 more are skipped, all
of them in the blocks gated behind `VESTRA_LIVE` and `VESTRA_DB` — the live-network
and live-database suites, which are opt-in and were last run at the Step 2
checkpoint. `npx tsc --noEmit` is silent and the dev server answers `GET /` with 200.
`npx eslint src` has one error left, in the spreadsheet preview that is still being
written (`set-state-in-effect`); every other file is clean.

### Landed since the last checkpoint

Read from the git log rather than from memory. Each line is what the commit put in
the tree; where a claim is stronger than "the code is there", it says what checked it.

- **A repository picker, and pasting a URL as the fallback** (D60). The list names
  and counts private repositories as absent rather than hiding them, and "no GitHub
  account linked" offers the paste field instead of an error.
- **Folder upload** (D62-D65). The browser filters with the server's own
  `classifyFile` before anything is sent, assets travel as a path and a size, and
  `projects.source` is a column with the repo fields nullable.
- **The graph view contract**, then **Step 3's workspace**: the district map, the
  side panel, the analysis screen and the live run over SSE. This closes the largest
  item on the last list — the analyze and events endpoints now have a caller in the
  product, not only in a test.
- **How far to look is a number you type**, not three buttons (D75), with `MAX_HOPS`
  at 6.
- **An aurora behind the whole site** (D76), fixed rather than absolute, `quiet` on
  the signed-in surfaces, and measured for contrast rather than eyeballed.
- **An uploaded folder's files are kept**, so its map opens from another computer
  (D77). Migration `0002_dazzling_chimera` adds `project_files`; `store.ts` holds the
  per-file, per-project and per-statement caps and has its own unit tests.
- **A face on the header, a mark on each sign-in button, and a way to delete a
  project**, with a confirmation that says what leaves with it — which for an upload
  is the files we hold.
- **Panes you can resize and fill the screen with**, with their own tests for the
  layout arithmetic.
- **A folder tree in the file list, and one mode picker instead of a button per
  mode**, with tests for the tree and for the mode vocabulary.
- **The landing page on a measured reference** (D70-D73), and a real overflow bug
  found behind D61's guard.

### Known and open, in priority order

1. **`fetches` edges still do not exist** (D56). Verified still absent: `fetches` is
   in the schema and in the view types, and nothing emits it. They are the only edges
   joining the demo app's client half to its server half, and Pass 2's grouping would
   be built on two disconnected islands.
2. **One sentence still explains re-reading an upload with a reason that is no longer
   true** — `src/components/app/analysis-trigger.tsx` says "올려주신 폴더는 코드를
   보관하지 않아서". Since D77 that reason is false. Nothing imports that file, which
   is its own question: it is either dead code to delete or a component that lost its
   caller when the workspace was built.
3. **A re-export barrel produces no `imports` edge.** Symbol-level resolution through
   the barrel is correct, so only the file-level graph is wrong — which is exactly
   what D52 feeds to Pass 2.
4. **Feature ids would hash the LLM's chosen name** (D55). Nothing writes them yet,
   so this is free to fix until Pass 2 lands, and expensive after.
5. **No ingest-progress events.** Verified still true: the ingest callback writes to
   the server log, with a comment saying why it is not reused as `file.parsed`. The
   download is the longest silent stretch of a run and the browser sees nothing
   during it.
6. **Two concurrent runs are checked for, not locked out.** `startAnalysis` asks the
   database for an active run and hands its id back instead of starting a second one,
   and a stale run is reaped by last-activity rather than by a startup sweep. Two
   simultaneous requests could still both pass the check; nothing in the database
   prevents it.
7. **D20's "a failed run drops its rows" is not implemented.** Verified still true —
   the failure path marks the run failed and drops nothing. It self-heals on the next
   successful sweep; between the two, the graph contains a partial run's work.
8. `file.parsed`'s `total` is an upper bound (18 parsed of 22 offered), so a progress
   bar driven by it stops short. The UI must finish on `run.completed`.
9. The fixture sources are invisible to `tsconfig.json` only because of a trailing
   `.txt`. Rename them and the product's own typecheck starts failing on a file that
   is broken on purpose.

Closed since the last list: "nothing in the UI calls either endpoint" (Step 3's
workspace does), and "a `static_site` project is told it will be read deeply"
(D68 — the summary now says only what ships, with a test pinning it).

### In flight today, not finished

Three other agents are working in the same tree right now. None of this is done, and
none of it should be described as done until whoever owns it says so:

- A spreadsheet preview.
- Deployment preparation.
- Re-reading an uploaded project from the files we now keep.

### Done and verified (Step 0-1)

- Repo initialized, brief moved to `docs/`.
- Step 0 answers recorded in `docs/DECISIONS.md` (D1-D5); scope widening and its seam
  (D6-D7); nine corrections from the stack audit (D15-D23).
- Scaffold: Next.js 16.3.5, React 19.2.8, Tailwind 4, TypeScript strict, App Router,
  `src/`, `@/*`.
- `src/lib/env.ts` — zod-validated server environment, one named error per missing
  variable.
- `src/db/index.ts` — pg pool + drizzle, cached on globalThis so dev hot reload does
  not exhaust Neon's connection limit.
- `src/lib/auth.ts` — Better Auth with GitHub and Google. No extra GitHub scopes
  requested: public repos need none, and an authenticated token is wanted only for
  the rate limit.
- **Database live.** Neon, Postgres 18.6, Singapore. Migration applied and checked
  against the running database: 11 tables, 9 enums, 30 indexes, 11 foreign keys.
  `select 'probably'::confidence` is rejected, so certain/inferred is enforced by
  Postgres.
- **Landing page.** Korean-first, warm near-black, 3D force graph hero that untangles
  as you scroll. Lazy-loaded behind a viewport and reduced-motion check, so phones
  and reduced-motion visitors get a still picture and never download three.js.
  Headline is real text and renders before the canvas.
- **Auth, verified by request rather than by assumption:** `GET /app`
  unauthenticated returns `307 -> /sign-in`; both providers build a valid authorize
  URL with the right client id, callback, scope and CSRF state.

### Done and verified (Step 2's engine)

- Verified against the real demo repo and the real Neon database, twice: 68 nodes,
  121 edges, all certain, byte-identical ids on the second run, `created_at`
  unchanged (upserted, not re-inserted), sweep deleted nothing.
- Both endpoints verified over real HTTP with a signed session: 401 unauthenticated,
  202 on your own project, **404 on someone else's** (not 403, which would confirm it
  exists), correct SSE headers, `Last-Event-ID: 22` replayed exactly `[23,24,25]`,
  and heartbeats at 0s/20s/40s/61s.

### Blocked on David

- Production OAuth callback URLs, once the first deployment has a domain. The local
  pair is already in place.
- A ruling on **O3** (whether Step 6's "the diff touched something you locked" notice
  counts as an out-of-scope guardrail). Needed before Step 6, not before then.

### Mocked or faked

- **The landing page hero graph is synthetic**, and deliberately so: it is an
  illustration of what an analysed app looks like, not a real analysis. It is
  generated clusters with generated links. Nothing in the product presents it as real
  output.
- Nothing else. All placeholders in `.env.local` have been replaced with real values.

### Not started

- Step 4 (semantic layer, Q&A, prompt generation, export), Step 5 (polish), Step 6
  (stretch).
