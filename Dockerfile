# syntax=docker/dockerfile:1

# A Dockerfile rather than Railway's automatic Nixpacks/Railpack detection,
# because this app's production behaviour depends on things a detector guesses
# at: which Node major runs it, that `node_modules` above the app does not exist
# (DECISIONS D39 — a stray one changes how the parser resolves `react` and
# silently changes the graph), and that no `.env.local` is anywhere near the
# build. A file we can read beats a build we have to trust.

# Node 22 because that is what the app is developed and measured against
# locally. Alpine because the runtime stage is served from it and stays small;
# `libc6-compat` is the glibc shim the prebuilt native binaries (sharp, the SWC
# compiler) expect to find.
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat


# ---------------------------------------------------------------------------
# deps — its own stage so a source-only change does not reinstall node_modules
# ---------------------------------------------------------------------------
FROM base AS deps
WORKDIR /app

COPY package.json package-lock.json ./
# `ci` and not `install`: the lockfile is the record of what was tested, and
# `install` is allowed to change it. Dev dependencies are needed here, because
# `next build` type-checks with TypeScript and `typescript` is one of them. They
# do not reach the final image.
#
# It does NOT lint. Next 16 removed `next lint` and `next build` no longer runs
# ESLint at all (see the version-16 upgrade guide in `node_modules/next/dist/
# docs/`). So this image is not a lint gate and never was one under 16 — a lint
# error will build and deploy perfectly happily. `npm run lint` is a separate
# step and has to be run somewhere that can fail the change.
RUN npm ci


# ---------------------------------------------------------------------------
# builder
# ---------------------------------------------------------------------------
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `src/lib/env.ts` validates the whole environment the first time it is
# imported, and `next build` imports every page module to compile it. With no
# values the build dies with "Environment is not configured" before it emits
# anything, which looks like a broken Dockerfile and is not.
#
# So: placeholders that satisfy the schema and mean nothing. They exist only in
# this stage. The runtime stage below is a separate image layer set and inherits
# none of them, so nothing here can be mistaken for a real secret at runtime.
# BETTER_AUTH_SECRET has a 32-character minimum, hence the padding.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?sslmode=disable" \
    BETTER_AUTH_SECRET="build-stage-placeholder-not-a-real-secret" \
    BETTER_AUTH_URL="http://localhost:3000" \
    GITHUB_CLIENT_ID="build-placeholder" \
    GITHUB_CLIENT_SECRET="build-placeholder" \
    GOOGLE_CLIENT_ID="build-placeholder" \
    GOOGLE_CLIENT_SECRET="build-placeholder"

# Next generates a fresh Server Action encryption key on every build unless it
# is told one. Two instances built separately, or an old tab talking to a new
# deploy, then fail with "Failed to find Server Action" — and this app uses
# Server Actions (`src/app/app/actions.ts`). Pass a stable key here to make
# those errors impossible; leaving it unset is only safe on a single instance
# whose users reload after a deploy. See docs/DEPLOY.md.
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=""
ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY}

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build


# ---------------------------------------------------------------------------
# runner — what actually ships
# ---------------------------------------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Not root. A container that compiles and writes other people's source files
# into temp directories is exactly the one that should not be able to write to
# its own system directories.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# `output: "standalone"` gives a server plus only the traced node_modules, so
# this stage never runs npm and carries no dev dependencies. It deliberately
# leaves out `public` and `.next/static`, on the assumption they are served by a
# CDN; there is no CDN here, so they are copied in and the server serves them.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

# Railway injects PORT and the app must honour it; 3000 is the fallback for a
# plain `docker run`. HOSTNAME must be 0.0.0.0 — the standalone server binds to
# localhost otherwise, and a health check from outside the container never
# arrives, which reads as "the app never started".
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
EXPOSE 3000

CMD ["node", "server.js"]
