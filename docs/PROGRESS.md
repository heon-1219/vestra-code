# Progress

What works, what is mocked, what is next. Updated at every checkpoint.
**Nothing in this file is described as working unless it has been run and checked.**

## Status: Step 1 in progress — nothing deployed yet

### Done
- Repo initialized, brief moved to `docs/`.
- Step 0 answers recorded in `docs/DECISIONS.md` (D1-D5).
- Scope widened to static sites, with the seam decision recorded (D6-D7).

### In progress
- Step 1: scaffold, Drizzle schema, Better Auth (GitHub + Google), landing page, first deployment.

### Blocked on David
- `DATABASE_URL` (Neon), GitHub OAuth client id + secret, Google OAuth client id + secret.
- Local callback URLs he is entering now, both verified against Better Auth's own docs source:
  - `http://localhost:3000/api/auth/callback/github`
  - `http://localhost:3000/api/auth/callback/google`
- Production callbacks follow once the first deployment has a domain.

### Mocked or faked
- Nothing. This section stays empty or says exactly what is fake and where it shows in the UI.

### Not started
- Step 2 (ingest + static analysis), Step 3 (live graph view), Step 4 (semantic layer, Q&A, prompt generation, export), Step 5 (polish), Step 6 (stretch).
