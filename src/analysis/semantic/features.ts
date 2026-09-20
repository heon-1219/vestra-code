import { createHash } from "node:crypto";

/**
 * A feature's identity, which is not its name.
 *
 * D55 is the whole of this file. A `feature` node's id is a hash of
 * `nodes.name`, so if `name` held the Korean the model chose, then the next run
 * renaming 결제 to 결제하기 would change the id — D20's sweep would delete the old
 * row, and `ON DELETE CASCADE` would silently take the user's own `belongs_to`
 * corrections with it. Section 6.1's "user rows win" would be broken through a
 * path that rule never considered, and nothing would report it.
 *
 * So the Korean goes in `label`, and `name` holds a key derived from what the
 * feature *is* rather than from what it is called: its members.
 *
 * ## Why the key is a hash of the member paths
 *
 * Every readable alternative was worse. The common directory of the members
 * collides — on a normal app 결제 and 장바구니 both reduce to `src` — and a
 * collision needs an arbitrary tie-break, which is exactly the coin flip a
 * stable id may not contain. The highest-ranked member's path churns whenever
 * degrees shift. A hash has no collisions, no tie-break and no ordering
 * dependency, and it is never read by a person: `grouping.ts` draws
 * `feature.label ?? feature.name` and this pass always writes a label.
 *
 * ## And why that is not enough on its own
 *
 * A hash of the members is stable under a rename and unstable under a
 * membership change, which is the opposite half of the same problem. So a
 * feature first tries to inherit the key of a feature the last run wrote:
 *
 *   1. **Same Korean name.** The obvious case, and the one D55 names: the
 *      members drifted by a file, the feature is plainly the same feature.
 *   2. **Mostly the same members.** The model renamed 결제 to 결제하기. Half the
 *      members in common is deliberately a low bar — the cost of matching two
 *      features that were genuinely different is one stale key, and the cost of
 *      failing to match is a user's correction deleted.
 *
 * Between them, a run that changes one axis keeps the id. A run that changes
 * both gets a new one, which is honest: at that point it is a different
 * grouping wearing a familiar word.
 */

/** A feature the last run left in the database. */
export type PreviousFeature = {
  /** Its `nodes.name` — the structural key this file is about. */
  key: string;
  /** Its `nodes.label`, the Korean the model chose last time. */
  label: string | null;
  /** The repo-relative paths of everything that `belongs_to` it. */
  memberPaths: readonly string[];
};

/**
 * Below this share of members in common, two features are not the same feature.
 * Half, for the reason in the header: the asymmetric cost of the two mistakes.
 */
export const SAME_FEATURE_OVERLAP = 0.5;

/**
 * Give one feature a key, preferring one it already had.
 *
 * `taken` is mutated: keys already assigned in this run, so two features can
 * never land on one row. Passing it in rather than returning it keeps the
 * caller a plain loop.
 */
export function featureKey(input: {
  label: string;
  memberPaths: readonly string[];
  previous: readonly PreviousFeature[];
  taken: Set<string>;
}): string {
  const { label, memberPaths, previous, taken } = input;
  const members = new Set(memberPaths);

  const byLabel = previous.find(
    (candidate) => candidate.label === label && !taken.has(candidate.key),
  );
  if (byLabel) return reserve(byLabel.key, taken);

  let best: { key: string; overlap: number } | null = null;
  for (const candidate of previous) {
    if (taken.has(candidate.key)) continue;
    const overlap = jaccard(members, new Set(candidate.memberPaths));
    if (overlap < SAME_FEATURE_OVERLAP) continue;
    // Ties break on the key so two equally-good matches resolve the same way
    // on every run; without it the answer would depend on row order.
    if (!best || overlap > best.overlap || (overlap === best.overlap && candidate.key < best.key)) {
      best = { key: candidate.key, overlap };
    }
  }
  if (best) return reserve(best.key, taken);

  return reserve(hashOf(memberPaths), taken);
}

/** 12 hex of SHA-256 over the sorted members. Not read by anyone; only matched. */
function hashOf(memberPaths: readonly string[]): string {
  const sorted = [...new Set(memberPaths)].sort();
  const digest = createHash("sha256")
    .update(JSON.stringify(["feature", sorted]))
    .digest("hex")
    .slice(0, 12);
  return `feature:${digest}`;
}

/**
 * Unreachable in practice — two features with identical member sets would have
 * to have survived `parseFeatureReply`'s duplicate-name check — and kept
 * because a silent id collision merges two territories into one and repoints
 * one of them at the other's members.
 */
function reserve(key: string, taken: Set<string>): string {
  let candidate = key;
  let at = 2;
  while (taken.has(candidate)) {
    candidate = `${key}:${at}`;
    at += 1;
  }
  taken.add(candidate);
  return candidate;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}
