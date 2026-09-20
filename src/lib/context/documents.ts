import type { GraphItem } from "@/lib/graph/view";

/**
 * Which of a project's files are a description of it.
 *
 * Chosen from the map rather than from a directory listing, and that is not a
 * convenience: the map is the authority for what belongs to this project, the
 * same rule `read_source` enforces in `src/qa/tools.ts`. A path that is not a
 * file on the map is not a file we may open, whatever it is called.
 *
 * ## Why this list is short
 *
 * Every file here costs a read and a share of one model call. The list is the
 * files that answer "what is this for?" and nothing else:
 *
 *   - **A root README.** For a Python project or a static site — which is what
 *     this user's real projects are — it is routinely the single best account
 *     of what the thing does, because the graph is thin and the code is not
 *     structured enough for the map to say much.
 *   - **`AGENTS.md` and `CLAUDE.md`.** Written for a machine, so they tend to
 *     say what the project is and where things live with no marketing in the
 *     way. An app that was prompted into existence usually has one.
 *   - **`docs/`.** Where a longer account goes when there is one.
 *
 * Deliberately not included: `CHANGELOG`, licences, issue templates, and a
 * README that is not at the root. A nested README is nearly always describing
 * one folder or a vendored library, and spending the budget on it buys a
 * description of the wrong thing.
 */

/** How many documents one digest is built from. */
export const MAX_CONTEXT_DOCUMENTS = 4;

const README = /^readme\.(md|mdx|txt)$/;
const PROSE = /\.(md|mdx|txt)$/;

/**
 * Lower sorts first. The order is what survives the cap, so it is the order of
 * how much each file tends to say about the project as a whole.
 */
function rankOf(path: string): number | null {
  const cut = path.lastIndexOf("/");
  const directory = cut === -1 ? "" : path.slice(0, cut);
  const base = path.slice(cut + 1).toLowerCase();

  if (directory === "") {
    if (README.test(base)) return 0;
    if (base === "agents.md" || base === "claude.md") return 1;
    if (base === "contributing.md") return 3;
    return null;
  }
  if (directory === "docs" && PROSE.test(base)) return 2;
  return null;
}

/**
 * The documents to boil down, best first, capped.
 *
 * An empty list is a normal answer and the important one: a project with no
 * README gets no digest, and the loop then runs exactly as it does today. A
 * smaller honest input, never an invented one.
 */
export function contextDocumentPaths(
  items: readonly GraphItem[],
  limit: number = MAX_CONTEXT_DOCUMENTS,
): string[] {
  const ranked: { path: string; rank: number }[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (item.kind !== "file" || !item.path) continue;
    if (seen.has(item.path)) continue;
    const rank = rankOf(item.path);
    if (rank === null) continue;
    seen.add(item.path);
    ranked.push({ path: item.path, rank });
  }

  // Not `localeCompare`: its ordering depends on the machine's collation, and a
  // digest built from a different pair of files on two hosts is a difference
  // nobody would think to look for.
  ranked.sort((a, b) =>
    a.rank !== b.rank ? a.rank - b.rank : a.path < b.path ? -1 : 1,
  );

  return ranked.slice(0, Math.max(0, limit)).map((one) => one.path);
}
