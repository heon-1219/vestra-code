import type { AnalyzedEdge, AnalyzedNode } from "@/analysis/types";

/**
 * Which connections are the same connection, so one sentence can serve them all.
 *
 * The founder asked for two things at once, and the second is what makes the
 * first affordable:
 *
 *   > "LLM이 직접 사용 용도를 분석하는걸로 하자. 사용 용도를 분석해서 한
 *   > sentence로 간단하게 정리. 물론, 동일한 기능을 하는 구조가 있다면 이
 *   > verb를 다시 가져와서 재사용 하도록."
 *
 * A 300-file project has thousands of edges. Describing each one separately is
 * unaffordable, slow, and — the part that matters more — **wrong**, because the
 * same fact would come back worded differently every time. Twelve components
 * calling `formatPrice` would get twelve sentences that all mean "가격을 보기
 * 좋게 바꿔요", and a map where the same relationship reads differently in
 * twelve places is a map nobody trusts.
 *
 * ## What makes two connections the same
 *
 * The relation and the thing on the far end. `PayButton → calls → formatPrice`
 * and `Receipt → calls → formatPrice` are both "이 화면이 가격을 사람이 읽는
 *모양으로 바꿔요" — the purpose lives in what is being reached for, not in who
 * is reaching.
 *
 * This is deliberately NOT "same relation" alone. Every `calls` edge in a
 * project is not one purpose; `calls formatPrice` and `calls chargeCard` are
 * different jobs, and collapsing them would produce a sentence so general it
 * says nothing ("함수를 불러요"), which is where the generic verbs came in.
 *
 * ## What this module does not do
 *
 * It does not talk to a model, and it does not rank by importance beyond
 * counting. It answers one question — which edges share a purpose — so that the
 * pass above it can ask about each group once, and so that the answer can be
 * tested without a network.
 */

/** One purpose, and every connection that shares it. */
export type PurposeGroup = {
  /** Stable across runs: the relation and the target's id. */
  key: string;
  relation: AnalyzedEdge["type"];
  /** The node every edge in this group points at. */
  targetId: string;
  /** Every edge that shares this purpose, in the order they were found. */
  edgeIds: string[];
  /**
   * How many distinct places reach for it.
   *
   * Not `edgeIds.length`: one file can call the same function twice, and that
   * is one place doing one thing rather than two places agreeing. This is the
   * number that decides which groups are worth asking about.
   */
  sources: number;
};

/**
 * Relations that get a purpose at all.
 *
 * `contains` is excluded and that is the whole list. A file holding a piece has
 * no purpose to explain — the map already says it by drawing one inside the
 * other, and "이 파일이 이 조각을 가지고 있어요" is the structure read back
 * aloud. `belongs_to` is the same: it is a grouping we made, not something the
 * code does.
 */
const EXPLAINABLE: ReadonlySet<AnalyzedEdge["type"]> = new Set([
  "calls",
  "renders",
  "fetches",
  "imports",
  "uses_package",
]);

/**
 * The separator between the two halves of a key, built at run time.
 *
 * The byte itself must not sit in the source. Written as an escape it does
 * not survive the trip into this file -- every layer between an editor and
 * the disk decodes it and writes the raw character back -- and a raw control
 * character makes the whole file read as binary to grep, to diff and to every
 * review tool. That has now bitten this codebase five times, twice in files
 * nobody would think to open.
 *
 * It has to be a character that cannot appear in a relation name or a node
 * id, because without one `calls` + `x` and `call` + `sx` are the same key.
 */
const KEY_SEPARATOR = String.fromCharCode(1);

export function purposeKey(relation: string, targetId: string): string {
  return `${relation}${KEY_SEPARATOR}${targetId}`;
}

/**
 * Group a project's edges by the purpose they share.
 *
 * Returned in a deterministic order — most-reached-for first, then by key — so
 * that two runs over an unchanged project ask about the same groups in the same
 * order, and a cache keyed on that order stays valid.
 */
export function groupByPurpose(
  edges: readonly AnalyzedEdge[],
  edgeIdOf: (edge: AnalyzedEdge) => string,
  targetIdOf: (edge: AnalyzedEdge) => string,
): PurposeGroup[] {
  const groups = new Map<string, PurposeGroup & { sourceIds: Set<string> }>();

  for (const edge of edges) {
    if (!EXPLAINABLE.has(edge.type)) continue;

    const targetId = targetIdOf(edge);
    const key = purposeKey(edge.type, targetId);
    const existing = groups.get(key);
    const sourceId = JSON.stringify(edge.source);

    if (existing) {
      existing.edgeIds.push(edgeIdOf(edge));
      existing.sourceIds.add(sourceId);
      continue;
    }
    groups.set(key, {
      key,
      relation: edge.type,
      targetId,
      edgeIds: [edgeIdOf(edge)],
      sources: 0,
      sourceIds: new Set([sourceId]),
    });
  }

  return [...groups.values()]
    .map(({ sourceIds, ...group }) => ({ ...group, sources: sourceIds.size }))
    .sort((a, b) => b.sources - a.sources || a.key.localeCompare(b.key));
}

/**
 * Which groups are worth asking a model about, given a budget.
 *
 * Ordered by how many distinct places reach for the thing, because that is what
 * a person is most likely to point at and the closest thing to importance we
 * can measure without asking. Everything below the line keeps the structural
 * verb, which is true and was never wrong — only general.
 *
 * `budget` is a number of questions, not tokens: each group costs one call, and
 * the caller knows what a call costs it.
 */
export function groupsWorthAsking(
  groups: readonly PurposeGroup[],
  budget: number,
): PurposeGroup[] {
  if (budget <= 0) return [];
  return groups.slice(0, budget);
}

/**
 * Apply one group's sentence to every edge in it.
 *
 * The reuse the founder asked for, and the reason a project of thousands of
 * edges costs a few dozen questions: the twelfth component to call
 * `formatPrice` is told the same thing as the first, for free, and in the same
 * words — which matters more than the cost, because a map that words the same
 * fact differently in twelve places is one nobody trusts.
 */
export function spreadPurpose(
  groups: readonly PurposeGroup[],
  answers: ReadonlyMap<string, string>,
): Map<string, string> {
  const byEdge = new Map<string, string>();
  for (const group of groups) {
    const sentence = answers.get(group.key);
    if (!sentence) continue;
    for (const edgeId of group.edgeIds) byEdge.set(edgeId, sentence);
  }
  return byEdge;
}

/**
 * A short label for a group, built from what it points at.
 *
 * Used to number the groups in a prompt instead of sending node id hashes
 * (D46), and to make a failed answer readable in a log.
 */
export function describeTarget(node: AnalyzedNode | undefined): string {
  if (!node) return "알 수 없는 것";
  return node.ref.name || node.ref.filePath || "이름 없는 것";
}
