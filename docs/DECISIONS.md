# Decisions

One line each: the decision, and why. Newest at the bottom of each section.
Anything here that contradicts `docs/MVP_BUILD_INSTRUCTIONS.md` supersedes the brief, and says so.

## Step 0 — Alignment (answered by David, 2026-09-18)

- **D1. UI language: Korean first, English later.** Not "both". Section 6.2 generates every feature name and node summary in the UI language, so a second language means a second stored string per generated value and a second LLM pass per analysis run — cost and latency on the slowest part of the product.
- **D2. LLM-generated text carries a language tag from the first migration.** Mine, not David's. Adding English later becomes additive instead of a migration over live data. Costs one column now.
- **D3. Deploy to Vercel today; move to a persistent Node host (Railway) before Step 2 ships.** Supersedes the Step 0 answer of "persistent Node host", for sequencing reasons only. David already has a Vercel account (his portfolio runs there) and Next.js is zero-config on it, so it is the fastest path to a live URL under a one-hour deadline. Serverless request-duration caps only bite when the analysis pipeline runs inside a request, which is Step 2 — not today. Same Next.js app either way, so the move is cheap.
- **D4. Deadline: a live deployment today, inside one hour.** Scope for that hour is Step 1 only (landing page, auth, empty `/app`, database schema). Steps 2-5 are explicitly not in it. Recorded because it is the constraint that explains every sequencing decision below.
- **D5. Primary demo repo: `heon-1219/coding-interview-prep`.** Next.js 14 App Router, JavaScript, 7 components, 4 API routes, 4 `lib/` helpers. It has genuinely shared components and multiply-used helpers, which the demo's best moment ("this is used in 3 places") needs in order to fire at all. `DCPortfolio` becomes a second project once D6 lands.

## Scope changes to the brief

- **D6. Support plain static sites (HTML + CSS + vanilla JS), not only React and Next.js.** David's call, 2026-09-18. **Supersedes** the brief's section 3 ("MVP supports React and Next.js repos in TypeScript or JavaScript only") and the section 4 out-of-scope line about other languages. Reason: the canonical user builds a site with an AI agent and loses track of it, and a large share of those sites have no framework at all — David's own portfolio is exactly this. Cost is not uniform: see D7.
- **D7. Pass 1 gets an analyzer seam now; the static-site analyzer itself lands in Step 2.** Mine. The interface (select an analyzer for a repo, hand it a filtered file list, have it emit nodes and edges) is nearly free to design before any code exists and expensive to retrofit once ts-morph is wired directly into the pipeline. The analyzer implementations are the real work and they do not block today's deployment. Deliberately not a plugin framework — two implementations behind one small interface, per section 8.

## Product decisions made without asking (section 2 says these are mine)

- **D8. "Reuse these" in the generated prompt is selected by graph proximity, not by an LLM.** Section 6.4 says the prompt is assembled from the graph by code and the LLM only restates the goal, but picking helpers "relevant to the request" is not a deterministic lookup. Resolution: rank exported helpers and components within N hops of the selection, plus others in the same feature, by connection count. Deterministic, testable, and wrong in boring ways instead of confident ones.
- **D9. A `user` `belongs_to` edge suppresses any `llm` `belongs_to` edge for the same source node.** Section 6.1's "user rows win" only says re-analysis must not delete or overwrite a user row, which would leave both edges present after the next run and put one item in two features. Suppression, not deletion, so the LLM's grouping returns if the user undoes their correction.
- **D10. Repository: `github.com/heon-1219/vestra-code`.** Brief lives at `docs/MVP_BUILD_INSTRUCTIONS.md`.

## Open — needs David

- **O1.** The workspace layout in David's hand-drawn wireframe conflicts with the brief's section 3 wireframe in four places (left panel: file tree vs feature list; center: live preview vs the map; a version-control panel that section 4 puts out of scope; the graph as a permanent full-height panel vs an opt-in tab). Deferred until the workspace is actually built — not on today's path.
- **O2.** Whether "deployed in an hour" means a live link to show someone, or a working product today. Changes how much of the hour goes to the landing page versus the analysis engine.
