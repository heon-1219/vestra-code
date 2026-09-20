/**
 * Where each change sits, and which lines join which.
 *
 * This is graph layout, and it is the one part of the 변경 기록 band that can
 * be wrong in a way nobody notices. A lane assignment that is subtly off does
 * not throw, does not blank the screen and does not look broken: it draws a
 * tidy picture of a history that is not the user's. Two independent lines of
 * work merged into one column read as one line of work. A merge drawn as a
 * plain step reads as a person who never branched. There is nothing on the
 * screen to check either against, which is exactly the shape of the failure
 * `runs.ts` was written to avoid at the top of this folder — so the rules live
 * here, pure, and the component only draws what they return.
 *
 * ## The model
 *
 * A **lane** is a vertical column. At any row, a lane is either free or is
 * *waiting for* one specific commit — the commit whose line will continue down
 * it. Walking the list newest first:
 *
 *   - A commit takes the lane that was waiting for it. If none was, it takes
 *     the leftmost free lane, which is how a branch tip enters the picture.
 *   - Any *other* lane that was also waiting for it collapses. Two lanes
 *     waiting for one commit is precisely a branch point seen from below: two
 *     children, one parent.
 *   - Its first parent carries on down the same lane. That is what keeps a
 *     mainline straight rather than wandering sideways every merge.
 *   - Its remaining parents — a merge has at least one — take a lane each,
 *     reusing one already waiting for that sha if there is one.
 *
 * ## Two rules about lines we refuse to draw
 *
 * **A parent outside the window gets no line.** The list is fifty commits of a
 * history that may be ten thousand, so the oldest rows have parents we were
 * never sent. Drawing a line to the bottom edge would be drawing a connection
 * to a commit we cannot name. Instead the node says `continues`, and the
 * picture shows a line leaving the bottom, which is a different and true claim.
 *
 * **A parent that appears ABOVE its child gets no line either.** GitHub returns
 * commits by date, not by ancestry, and a rebase or a cherry-pick can date a
 * parent after its own child. An upward line in a picture whose entire grammar
 * is "older is further down" would be the picture contradicting itself.
 */

/** Everything the layout needs from a commit. `ChangeCommit` satisfies this. */
export type LaneCommit = {
  sha: string;
  /** Full SHAs, in git's order: the first is the line this change continued. */
  parents: readonly string[];
};

export type ChangeNode = {
  sha: string;
  /** Position in the list, 0 = newest. */
  row: number;
  /** Which column the dot sits in, 0 = leftmost. */
  lane: number;
  /** Two or more parents: this change joined two lines of work together. */
  merge: boolean;
  /** Two or more changes in this window build directly on it: it split. */
  split: boolean;
  /** At least one parent is older than the window, so the line carries on. */
  continues: boolean;
};

export type ChangeEdge = {
  /** The newer end — the child. */
  fromSha: string;
  fromRow: number;
  fromLane: number;
  /** The older end — the parent. Always at a greater row. */
  toSha: string;
  toRow: number;
  toLane: number;
  /** 0 for the first parent, the line this change carried on. */
  parentIndex: number;
};

export type ChangeGraph = {
  nodes: ChangeNode[];
  edges: ChangeEdge[];
  /** How many columns the picture needs. 0 when there is nothing to draw. */
  laneCount: number;
};

export const EMPTY_GRAPH: ChangeGraph = { nodes: [], edges: [], laneCount: 0 };

export function layoutChanges(commits: readonly LaneCommit[]): ChangeGraph {
  /*
   * Deduplicated before anything else.
   *
   * A repeated sha would get two rows and two dots, and the second one would
   * steal every line meant for the first — `rowOf` holds one row per sha, so
   * the picture would quietly attach a project's history to the wrong copy. It
   * should not happen; it costs one pass to make sure it cannot.
   */
  const ordered: LaneCommit[] = [];
  const rowOf = new Map<string, number>();
  for (const commit of commits) {
    if (rowOf.has(commit.sha)) continue;
    rowOf.set(commit.sha, ordered.length);
    ordered.push(commit);
  }
  if (ordered.length === 0) return EMPTY_GRAPH;

  // How many changes in this window name each sha as a parent. Two or more is
  // a branch point, read from the only side a window can see it from: below.
  const children = new Map<string, number>();
  for (const commit of ordered) {
    // A commit listing the same parent twice is degenerate but legal, and it
    // is not two children.
    for (const parent of new Set(commit.parents)) {
      children.set(parent, (children.get(parent) ?? 0) + 1);
    }
  }

  /** What each lane is waiting for, or null when it is free. */
  const waiting: (string | null)[] = [];
  let maxLane = 0;

  const claim = (sha: string): number => {
    const free = waiting.indexOf(null);
    const lane = free === -1 ? waiting.length : free;
    waiting[lane] = sha;
    if (lane > maxLane) maxLane = lane;
    return lane;
  };

  const nodes: ChangeNode[] = [];
  /*
   * Edges are collected without their far end and resolved afterwards.
   *
   * A lane is *reserved* for a parent when a child is walked past, but the
   * parent's real lane is only decided when we reach the parent itself — and
   * it is often not the one this child reserved. Two children of one commit
   * reserve two different columns; the commit takes one of them and the other
   * collapses. Writing the reserved lane down as the line's destination is
   * the quiet version of this bug: half the lines into a branch point land
   * beside it, pointing at a column with nothing in it.
   */
  const pending: (Omit<ChangeEdge, "toLane" | "toRow"> & { toRow: number })[] = [];

  for (const [row, commit] of ordered.entries()) {
    let lane = waiting.indexOf(commit.sha);
    if (lane === -1) {
      // Nothing was waiting for it: a branch tip, or the newest commit.
      lane = claim(commit.sha);
    }
    waiting[lane] = null;
    if (lane > maxLane) maxLane = lane;

    // Every other lane waiting for this same commit collapses into this one.
    // Freed before the parents are placed, so a merge's second parent may take
    // a column that has just been given up rather than widening the picture.
    for (let i = 0; i < waiting.length; i += 1) {
      if (waiting[i] === commit.sha) waiting[i] = null;
    }

    /*
     * A parent is only followed downwards.
     *
     * `undefined` means it is older than the window — worth holding the lane
     * for, because that lane is the line leaving the bottom of the picture. A
     * row at or above this one means the list is not in ancestry order, and
     * reserving a lane for something we have already walked past would hold
     * that column open for the rest of the list and never use it.
     */
    const followable = (sha: string): boolean => {
      const at = rowOf.get(sha);
      return at === undefined || at > row;
    };

    const parents = [...new Set(commit.parents)];
    for (const [index, parent] of parents.entries()) {
      if (!followable(parent)) continue;

      if (index === 0) {
        // The first parent carries on in this commit's own lane, which is what
        // keeps a mainline a straight column instead of a staircase.
        waiting[lane] = parent;
      } else if (waiting.indexOf(parent) === -1) {
        claim(parent);
      }

      const parentRow = rowOf.get(parent);
      // Only a parent we were actually sent gets a line. The rest is said by
      // `continues` instead, which is a claim we can stand behind.
      if (parentRow !== undefined) {
        pending.push({
          fromSha: commit.sha,
          fromRow: row,
          fromLane: lane,
          toSha: parent,
          toRow: parentRow,
          parentIndex: index,
        });
      }
    }

    nodes.push({
      sha: commit.sha,
      row,
      lane,
      merge: parents.length >= 2,
      split: (children.get(commit.sha) ?? 0) >= 2,
      continues: parents.some((parent) => !rowOf.has(parent)),
    });
  }

  // Now every commit has its final lane, so each line can be given the column
  // its far end actually sits in rather than the one it was reserved.
  const laneOf = new Map(nodes.map((node) => [node.sha, node.lane]));
  const edges: ChangeEdge[] = pending.map((edge) => ({
    ...edge,
    toLane: laneOf.get(edge.toSha) ?? edge.fromLane,
  }));

  return { nodes, edges, laneCount: maxLane + 1 };
}
