import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

/**
 * The graph, in plain Postgres tables. Section 6.1 of the brief.
 *
 * Two rules from the brief drive most of the shape here:
 *
 *   1. Stable ids. A node id is a hash of (project, type, file path, name), so
 *      re-analysis produces the same id for the same thing and user corrections
 *      and chat citations keep pointing at the right place. Analyzers never
 *      compute these themselves — they emit a natural key and one shared
 *      function does the hashing, so a typo in one analyzer cannot silently
 *      fork the graph.
 *
 *   2. User rows win. Re-analysis replaces `static` and `llm` rows and never
 *      touches a row with `origin = 'user'`.
 */

// --- Vocabularies ----------------------------------------------------------
// These are database enums rather than free text on purpose. `confidence` in
// particular is the product's honesty guarantee (section 3) — the UI draws a
// solid or dotted line from it — so a typo should fail the insert, not reach a
// user as a confident claim.

export const nodeTypeEnum = pgEnum("node_type", [
  "file",
  "symbol",
  "route",
  "api_endpoint",
  "package",
  "feature",
]);

export const symbolKindEnum = pgEnum("symbol_kind", [
  "component",
  "function",
  "hook",
  "class",
  "type",
  // Static sites: one CSS rule. Added for the widened scope (DECISIONS D6) —
  // it is the only new kind that scope needed.
  "style_rule",
]);

export const edgeTypeEnum = pgEnum("edge_type", [
  "contains",
  "imports",
  "calls",
  "renders",
  "fetches",
  "uses_package",
  "belongs_to",
]);

/**
 * `certain` means the compiler resolved it. `inferred` means a heuristic or an
 * LLM produced it. There is deliberately no third value: "probably" is not a
 * thing this product is allowed to say.
 */
export const confidenceEnum = pgEnum("confidence", ["certain", "inferred"]);

export const originEnum = pgEnum("origin", ["static", "llm", "user"]);

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

export const runPhaseEnum = pgEnum("run_phase", [
  "ingest",
  "static",
  "semantic",
  "done",
]);

/**
 * What kind of project this is, which decides which analyzer runs.
 *
 * Deliberately three values, not a ladder of framework classes. Every
 * unsupported framework resolves to the same message, so distinguishing Astro
 * from SvelteKit from Hugo buys the user nothing and costs a fixture and a
 * copy string each.
 */
export const projectKindEnum = pgEnum("project_kind", [
  "nextjs",
  "react_spa",
  "static_site",
  "unsupported",
]);

export const chatRoleEnum = pgEnum("chat_role", ["user", "assistant"]);

/**
 * Where a project's files came from.
 *
 * This is not cosmetic. A GitHub project can have its source re-fetched on
 * demand, which is what makes section 3's promise work — we keep the graph and
 * fetch a line range only when someone asks to see it. An uploaded folder has
 * no such origin: once the analysis is done and the temp directory is gone,
 * there is nowhere to fetch from. The Q&A agent's `read_source` therefore
 * cannot work for uploads, and must say so rather than fail.
 */
export const projectSourceEnum = pgEnum("project_source", ["github", "upload"]);

// --- Tables ----------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /**
     * Null for an uploaded folder, which has no owner, no remote and no branch.
     * Postgres treats NULLs as distinct in a unique index, so several uploads
     * by one user do not collide on `projects_user_repo_idx`.
     */
    source: projectSourceEnum("source").notNull().default("github"),
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    repoUrl: text("repo_url"),
    defaultBranch: text("default_branch"),

    /** What the user sees. Defaults to the repo name, and they can rename it. */
    displayName: text("display_name").notNull(),

    kind: projectKindEnum("kind").notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("projects_user_id_idx").on(table.userId),
    // One project per repo per user. Re-adding the same repo should reopen the
    // existing project rather than silently building a second graph of it.
    uniqueIndex("projects_user_repo_idx").on(
      table.userId,
      table.repoOwner,
      table.repoName,
    ),
  ],
);

export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    status: runStatusEnum("status").notNull().default("pending"),
    phase: runPhaseEnum("phase").notNull().default("ingest"),

    /** The commit we actually analyzed, so the graph can be dated. */
    commitSha: text("commit_sha"),
    /** Which analyzer ran, e.g. "typescript" or "web". */
    analyzer: text("analyzer"),

    filesParsed: integer("files_parsed").notNull().default(0),
    nodeCount: integer("node_count").notNull().default(0),
    edgeCount: integer("edge_count").notNull().default(0),
    /** Files we could not parse. One bad file must not fail a run (section 6.2). */
    filesSkipped: jsonb("files_skipped").$type<string[]>().notNull().default([]),

    /** Plain-language failure reason. Technical detail goes to logs, not here. */
    error: text("error"),

    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [index("analysis_runs_project_idx").on(table.projectId)],
);

/**
 * Events are persisted as they are emitted so the SSE endpoint can replay them
 * by cursor. This is what makes "refresh mid-run without losing state"
 * (Step 3's done-when) work: the browser reconnects and asks for everything
 * after the last sequence number it saw, rather than depending on an in-memory
 * emitter that died with the previous request (DECISIONS D16).
 */
export const analysisEvents = pgTable(
  "analysis_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    /** Monotonic per run. Doubles as the SSE `Last-Event-ID` cursor. */
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("analysis_events_run_seq_idx").on(table.runId, table.seq)],
);

export const nodes = pgTable(
  "nodes",
  {
    /** Stable hash of (projectId, type, filePath, name). Never random. */
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    type: nodeTypeEnum("type").notNull(),
    kind: symbolKindEnum("kind"),

    /** The name in the code: `formatPrice`, `.media-card`, `checkout/page.tsx`. */
    name: text("name").notNull(),

    /**
     * Plain-language name and one-sentence description, generated in Pass 2.
     * `textLang` records which language they are in, so adding English later
     * is a new table with a fallback to these columns rather than a rewrite of
     * live data (DECISIONS D2).
     */
    label: text("label"),
    summary: text("summary"),
    textLang: text("text_lang"),

    /** Repo-relative, POSIX separators, no archive prefix (DECISIONS D18). */
    filePath: text("file_path"),
    startLine: integer("start_line"),
    endLine: integer("end_line"),

    origin: originEnum("origin").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    /**
     * The last run that saw this row. After a run succeeds, static and llm rows
     * whose lastSeenRunId is not the current run are deleted; user rows never
     * are. A failed run skips that sweep, so the previous graph survives intact
     * rather than being left half-replaced (DECISIONS D20).
     */
    lastSeenRunId: text("last_seen_run_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("nodes_project_type_idx").on(table.projectId, table.type),
    index("nodes_project_path_idx").on(table.projectId, table.filePath),
    index("nodes_project_origin_idx").on(table.projectId, table.origin),
    index("nodes_sweep_idx").on(table.projectId, table.lastSeenRunId),
  ],
);

export const edges = pgTable(
  "edges",
  {
    /** Stable hash of (projectId, type, sourceNodeId, targetNodeId). */
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    sourceNodeId: text("source_node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    targetNodeId: text("target_node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),

    type: edgeTypeEnum("type").notNull(),
    confidence: confidenceEnum("confidence").notNull(),
    origin: originEnum("origin").notNull(),

    /** Call-site line, matched selector, and similar provenance. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    lastSeenRunId: text("last_seen_run_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("edges_project_source_idx").on(table.projectId, table.sourceNodeId),
    index("edges_project_target_idx").on(table.projectId, table.targetNodeId),
    index("edges_project_type_idx").on(table.projectId, table.type),
    index("edges_sweep_idx").on(table.projectId, table.lastSeenRunId),
  ],
);

/**
 * Chat history.
 *
 * This table stores the user's question, the assistant's final text, and the
 * node ids it cited. It deliberately does NOT store tool results. The Q&A
 * agent's `read_source` tool returns the user's source code, and persisting
 * that would break the section 3 promise that we do not keep source — in the
 * very first feature that touches it. Citations re-fetch on render instead
 * (DECISIONS D19).
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: chatRoleEnum("role").notNull(),
    content: text("content").notNull(),
    /** Node ids the answer cited, in the order the chips appear. */
    citations: jsonb("citations").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("chat_messages_project_idx").on(table.projectId, table.createdAt)],
);

export const generatedPrompts = pgTable(
  "generated_prompts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),

    /** What the user selected. */
    selectionNodeIds: jsonb("selection_node_ids").$type<string[]>().notNull(),

    /**
     * The lock state at the moment of generation, snapshotted rather than
     * referenced. Step 6 has to answer "did the agent touch something you
     * locked?" after the run finishes, and it needs the locks that were in
     * force when the prompt was written, not whatever the UI holds now
     * (DECISIONS D23).
     */
    lockState: jsonb("lock_state")
      .$type<{ editable: string[]; locked: string[] }>()
      .notNull(),

    /** "only_here" or "everywhere", when the selection is rendered in several places. */
    sharedScope: text("shared_scope"),

    /** The user's own words. */
    userRequest: text("user_request").notNull(),
    /** The assembled prompt, behind the "Show prompt" toggle. */
    promptText: text("prompt_text").notNull(),
    /** The plain confirmation shown instead of the prompt. */
    confirmationText: text("confirmation_text").notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("generated_prompts_project_idx").on(table.projectId, table.createdAt)],
);
