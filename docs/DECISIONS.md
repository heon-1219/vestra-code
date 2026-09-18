# Decisions

One line each: the decision, and why. Newest at the bottom of each section.
Anything here that contradicts `docs/MVP_BUILD_INSTRUCTIONS.md` supersedes the brief, and says so.

## Step 0 — Alignment (answered by David, 2026-09-18)

- **D1. UI language: Korean first, English later.** Not "both". Section 6.2 generates every feature name and node summary in the UI language, so a second language means a second stored string per generated value and a second LLM pass per analysis run — cost and latency on the slowest part of the product.
- **D2. LLM-generated text carries a language tag from the first migration.** Mine, not David's. Adding English later becomes additive instead of a migration over live data. Costs one column now.
- **D3. Deploy to a persistent Node host (Railway). ~~Vercel first.~~** *Revised 2026-09-18 after the deadline moved from one hour to two days.* The original answer was a persistent host; I briefly overrode it to reach a live URL inside an hour. With two days, Step 2's analysis pipeline lands inside the window, and that is exactly what a serverless request-duration cap breaks — a full run is a tarball download plus a parse of hundreds of files plus an LLM pass. Going to Vercel first would also mean registering production OAuth callback URLs twice. Straight to Railway.
- **D4. Deadline: two days for the full MVP, with quality per step over speed.** *Revised from "one hour, Step 1 only".* Steps 1-5 are in the window. Step 6 remains stretch. This restores the brief's step rhythm: verify every "done when" before the checkpoint, and do not move on without David's go-ahead.
- **D5. Primary demo repo: `heon-1219/coding-interview-prep`.** Next.js 14 App Router, JavaScript, 7 components, 4 API routes, 4 `lib/` helpers. It has genuinely shared components and multiply-used helpers, which the demo's best moment ("this is used in 3 places") needs in order to fire at all. `DCPortfolio` becomes a second project once D6 lands.

## Scope changes to the brief

- **D6. Support plain static sites (HTML + CSS + vanilla JS), not only React and Next.js.** David's call, 2026-09-18. **Supersedes** the brief's section 3 ("MVP supports React and Next.js repos in TypeScript or JavaScript only") and the section 4 out-of-scope line about other languages. Reason: the canonical user builds a site with an AI agent and loses track of it, and a large share of those sites have no framework at all — David's own portfolio is exactly this. Cost is not uniform: see D7.
- **D7. Pass 1 gets an analyzer seam now; the static-site analyzer itself lands in Step 2.** Mine. The interface (select an analyzer for a repo, hand it a filtered file list, have it emit nodes and edges) is nearly free to design before any code exists and expensive to retrofit once ts-morph is wired directly into the pipeline. The analyzer implementations are the real work. Deliberately not a plugin framework — two implementations behind one small interface, per section 8.

## Stack, verified against npm on 2026-09-18 (not from memory)

- **D11. Next.js 16.3.5, React 19.2.8, Tailwind 4.3.3, TypeScript 5, Node 22.14.** The brief's "Next.js 16" is current — `latest` on npm is 16.3.5. Tailwind is v4, which is CSS-first: no `tailwind.config.js`, theme tokens live in CSS under `@theme`. Scaffolded with `--ts --tailwind --eslint --app --src-dir --import-alias "@/*"`.
- **D12. Scaffolded into a subfolder and lifted, because the working directory name contains a space** and npm rejects it as a package name. Package name is `vestra-code` per the brief.
- **D13. Postgres driver: `pg` with a connection pool, not the Neon serverless HTTP driver.** Follows from D3 — a persistent Node process holds long-lived connections, and Pass 1 writes thousands of rows incrementally, which is the worst case for a per-query HTTP driver. Neon speaks standard Postgres, so this costs nothing.

## Product decisions made without asking (section 2 says these are mine)

- **D8. "Reuse these" in the generated prompt is selected by graph proximity, not by an LLM.** Section 6.4 says the prompt is assembled from the graph by code and the LLM only restates the goal, but picking helpers "relevant to the request" is not a deterministic lookup. Resolution: rank exported helpers and components within N hops of the selection, plus others in the same feature, by connection count. Deterministic, testable, and wrong in boring ways instead of confident ones.
- **D9. A `user` `belongs_to` edge suppresses any `llm` `belongs_to` edge for the same source node.** Section 6.1's "user rows win" only says re-analysis must not delete or overwrite a user row, which would leave both edges present after the next run and put one item in two features. Suppression, not deletion, so the LLM's grouping returns if the user undoes their correction.
- **D10. Repository: `github.com/heon-1219/vestra-code`.** Brief lives at `docs/MVP_BUILD_INSTRUCTIONS.md`.
- **D14. `create-next-app` generated its own `AGENTS.md` and `CLAUDE.md` at the repo root.** These describe *our* repo. The `AGENTS.md` the product *generates* for a user's analyzed project (section 6.4, Export) is a different artifact and must not be written to the repo root — it is a download.

## Open — needs David

- **O1.** The workspace layout in David's hand-drawn wireframe conflicts with the brief's section 3 wireframe in four places (left panel: file tree vs feature list; center: live preview vs the map; a version-control panel that section 4 puts out of scope; the graph as a permanent full-height panel vs an opt-in tab). To be resolved before Step 3 builds the workspace, with the UI research in hand.
- ~~**O2.** What "deployed in an hour" means.~~ Moot — deadline is now two days (D4).

## From the stack audit, 2026-09-18 (25 agents, verified against current docs)

These are corrections to how the brief says to build things. Each one was found by
reading current documentation, and the high-severity ones were re-checked by a second
agent trying to refute them. Full run: 53 findings, 8 high, 1 refuted.

- **D15. Pass 1 must read `tsconfig.json`/`jsconfig.json` for `baseUrl` and `paths` only — never the rest of the config.** The brief (6.2) says to build the ts-morph project without the repo's tsconfig. Taken literally that is a silent failure: `@/components/Button` is a bare specifier, so TypeScript walks `node_modules`, which does not exist in an unbuilt tarball, and resolves to nothing. Every alias import in an idiomatic Next.js app would produce no edge at all, and Pass 1 would emit a confident, disconnected graph. Keep the brief's intent (the repo's `target`/`lib`/`strict` never decide our parse) but lift the path mappings out, tolerating comments and trailing commas, and fall back to probing `@/* → src/*` then `./*`.
- **D16. Starting a run and streaming it are two endpoints, not one.** `POST /api/projects/:id/analyze` starts the run and returns an `analysis_run` id immediately; `GET .../runs/:runId/events` tails *persisted* events by cursor (`Last-Event-ID`) and closes on `run.completed`. The brief's sequence diagram runs the pipeline inside the SSE request, which cannot satisfy Step 3's "refresh mid-run without losing state" — a refresh opens a second, isolated request with no access to the first run's emitter. This keeps 6.2's "the pipeline knows nothing about HTTP" intact and is the same shape a background worker would need.
- **D17. Railway's real limits, since D3 picked it: 15 minutes maximum per HTTP request, closed after 5 minutes with no data transferred, websockets exempt.** So SSE must send a heartbeat every ~20s unconditionally — including across the long Pass 2 LLM call — and the route must set `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`. (For contrast, Vercel is 300s hard on Hobby and 800s max on Pro, which is what D3 avoided.)
- **D18. Strip the tarball's top-level directory at ingest.** GitHub archives extract to `{owner}-{repo}-{sha}/`, so the commit SHA would land inside every `file_path` and stable ids would change on every commit — breaking rule 1 of section 6.1 exactly where it matters. Store paths repo-relative and POSIX-separated, and assert in the Step 2 tests that no stored path contains the repo name or a SHA.
- **D19. `chat_messages` stores user turns, final assistant text, and citation node ids — never tool results or source snippets.** The obvious chat implementation persists tool output so the conversation survives a refresh, but `read_source` output *is* the user's source code, which would put it in Postgres and break the section 3 trust promise in the first feature that touches it. Re-fetch on render instead.
- **D20. Re-analysis stages rows under the new `analysis_run_id` and promotes atomically at the end.** The brief says re-analysis "replaces" static and llm rows, which read literally means mutating the live graph while the user is looking at it, and a run that fails halfway leaves a half-graph. Staging means a failed run drops its rows and the previous graph stands.
- **D21. `next/dynamic` with `ssr: false` is illegal in a Server Component.** Pages are Server Components by default, so the brief's graph-rendering note compiles only behind a thin `'use client'` wrapper module per graph. Ten-minute fix, an hour of confusion if undiscovered — and it lands on both of the most visible deliverables (Step 1 hero, Step 3 workspace).
- **D22. Install `react-force-graph-2d` and `react-force-graph-3d`, not the umbrella `react-force-graph`.** The umbrella depends on the AR and VR renderers (A-Frame plus three.js) whether or not they are used, against a Step 1 done-when of "stays smooth on a mid-range laptop".
- **D23. The lock set is snapshotted into the `generated_prompts` row.** Locks are promised in three sections of the brief and stored in none. Without a snapshot, Step 6's "tell the user if the diff touched something locked" has nothing to compare against once the agent finishes.

## Open — needs David (added from the audit)

- **O3.** Section 4 puts "guardrail checks on agent diffs" out of scope, but Step 6 requires telling the user when a diff touched something they locked. That check *is* a guardrail on an agent diff. My reading: section 4 means no automated blocking policy engine, and Step 6's after-the-fact notice is a report, so it stays in. Needs a one-line ruling before Step 6, not before then.
