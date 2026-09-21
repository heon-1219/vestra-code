import { describeAll } from "@/lib/graph/describe";
import {
  RELATION_WORDS,
  type Certainty,
  type ConnectionRelation,
  type GraphConnection,
  type GraphItem,
} from "@/lib/graph/view";

/**
 * 설명하기, the free half: what is already known about one thing.
 *
 * The founder's sentence for this mode is "고른 것이 무슨 일을 하는지, 평소 쓰는
 * 말로 풀어 드려요", and most of the time the answer is already sitting in the
 * graph the browser holds — Pass 2 wrote a plain name and a sentence for most
 * items, Pass 3 wrote what most connections are *for*, and the parser counted
 * who uses what. So this is zero model calls, zero network, and it renders in
 * the same frame as the click (D155). The deep read is a button beside it, not
 * the default.
 *
 * ## Two sources, never blended
 *
 * The rule `ModelMark` exists for applies to every line here: **a sentence a
 * model wrote and a sentence the parser counted look alike and must not read
 * alike.** So the result is split by who wrote it, not by topic:
 *
 *   - `measured` — `describe.ts`'s line computed *without* the Pass 2 summary
 *     (which would otherwise replace it), the path and line range, and every
 *     connection with its verb and its own certainty word. The parser read
 *     these; nothing here is a model's opinion. The certainty word is still
 *     per connection, because a heuristic import is counted by us and still
 *     only 짐작이에요.
 *   - `written` — the label, the summary, the feature it was grouped under and
 *     the purpose sentences, and for a feature the things grouped under it.
 *     Every one of them is a model's reading, so every one of them is marked.
 *
 * Two sentences this file will never produce, both from `describe.ts`: 안전해요,
 * and 아무 데서도 안 써요. Nothing found using a thing is 쓰는 곳을 아직 못
 * 찾았어요 — a statement about our reading, not about their code.
 */

export type KnownRow = {
  item: GraphItem;
  relation: ConnectionRelation;
  certainty: Certainty;
  /** The verb, standing on the explained item — the panel's own wording. */
  verb: string;
  /** What this connection is for, when Pass 3 wrote it. A model's sentence. */
  purpose: string | null;
};

export type KnownSide = {
  /** Distinct things, before the cap. */
  total: number;
  certain: number;
  inferred: number;
  rows: KnownRow[];
};

export type KnownExplanation = {
  item: GraphItem;
  /** Counted by the parser. Never a model's sentence. */
  measured: {
    line: string;
    /** The file it is written in, for a piece. */
    home: GraphItem | null;
    /** How many things are written inside it, for a file. */
    inside: number;
    uses: KnownSide;
    usedBy: KnownSide;
  };
  /** Written by a model. Each field is null when Pass 2 or 3 wrote nothing. */
  written: {
    label: string | null;
    summary: string | null;
    feature: GraphItem | null;
    /** How many of the rows above carry a purpose sentence. */
    purposes: number;
    /**
     * For a feature, what a model grouped under it; null for anything else.
     *
     * A feature is used by nothing — its rows are `belongs_to`, a model's
     * grouping — so its 어디서 쓰이나요 read 쓰는 곳을 아직 못 찾았어요 on 9 of 9
     * features on this repository's map and 6 of 6 on Kim-and-Chang-, under a
     * panel header that said 45곳에서 쓰여요. What a feature has is members,
     * and they belong in this half: every `belongs_to` is 짐작이에요.
     */
    members: KnownSide | null;
  };
};

/** Per side. The panel's list above has the rest, with its switches. */
export const KNOWN_ROWS = 5;

const REACHES: ReadonlySet<ConnectionRelation> = new Set<ConnectionRelation>([
  "calls",
  "renders",
  "fetches",
  "imports",
  "uses_package",
]);

export function explainKnown(
  graph: { items: readonly GraphItem[]; connections: readonly GraphConnection[] },
  itemId: string,
): KnownExplanation | null {
  const byId = new Map(graph.items.map((item) => [item.id, item]));
  const item = byId.get(itemId);
  if (!item) return null;

  /*
   * The measured line for this one item, with its summary taken away.
   *
   * `describeAll` returns Pass 2's summary wherever one exists — right for the
   * map's tooltip, which has room for one line — and the whole point here is
   * to show both, each under its own author. Stripping only this item keeps
   * every other item's `holds` intact, which `describeItem` cannot do: it is
   * handed one item, so a file's children are not in its lookup and the file
   * would read as 안을 읽지 않은 파일이에요.
   */
  const items = graph.items.map((candidate) =>
    candidate.id === itemId ? { ...candidate, summary: null } : candidate,
  );
  const line = describeAll({ items, connections: graph.connections }).get(itemId)?.line ?? "";

  let home: GraphItem | null = null;
  let inside = 0;
  let feature: GraphItem | null = null;
  const uses = new Map<string, KnownRow>();
  const usedBy = new Map<string, KnownRow>();
  const members = new Map<string, KnownRow>();

  for (const connection of graph.connections) {
    if (connection.from === connection.to) continue;
    const outgoing = connection.from === itemId;
    const incoming = connection.to === itemId;
    if (!outgoing && !incoming) continue;
    const other = byId.get(outgoing ? connection.to : connection.from);
    if (!other) continue;

    if (connection.relation === "contains") {
      if (outgoing) inside += 1;
      else home ??= other;
      continue;
    }
    if (connection.relation === "belongs_to") {
      if (outgoing && other.kind === "feature") feature ??= other;
      if (incoming && item.kind === "feature" && !members.has(other.id)) {
        members.set(other.id, {
          item: other,
          relation: connection.relation,
          certainty: connection.certainty,
          // Standing on the member, the way every row on this card stands on
          // the far end: "account-strip.tsx 이 기능에 속해요".
          verb: RELATION_WORDS.belongs_to.forward,
          purpose: connection.purpose ?? null,
        });
      }
      continue;
    }
    if (!REACHES.has(connection.relation)) continue;

    const side = outgoing ? uses : usedBy;
    const existing = side.get(other.id);
    const row: KnownRow = {
      item: other,
      relation: connection.relation,
      certainty: connection.certainty,
      verb: RELATION_WORDS[connection.relation][outgoing ? "forward" : "backward"],
      purpose: connection.purpose ?? null,
    };
    // Two links to one place are one place. Keep the surer one, and the one
    // with a sentence when both are equally sure.
    if (
      !existing ||
      (existing.certainty === "inferred" && row.certainty === "certain") ||
      (existing.certainty === row.certainty && !existing.purpose && row.purpose)
    ) {
      side.set(other.id, row);
    }
  }

  const usesSide = sideOf(uses);
  const usedBySide = sideOf(usedBy);

  return {
    item,
    measured: { line, home, inside, uses: usesSide, usedBy: usedBySide },
    written: {
      label: item.label && item.label !== item.name ? item.label : null,
      summary: item.summary && item.summary.trim().length > 0 ? item.summary.trim() : null,
      feature,
      purposes: [...usesSide.rows, ...usedBySide.rows].filter((row) => row.purpose).length,
      members: item.kind === "feature" ? sideOf(members) : null,
    },
  };
}

function sideOf(rows: Map<string, KnownRow>): KnownSide {
  const all = [...rows.values()].sort(compareRows);
  const certain = all.filter((row) => row.certainty === "certain").length;
  return {
    total: all.length,
    certain,
    inferred: all.length - certain,
    rows: all.slice(0, KNOWN_ROWS),
  };
}

/**
 * Surest first, then the ones with a sentence to read, then the busiest.
 *
 * Deterministic to the id, for the reason `neighbourhood.ts` gives: the same
 * selection must read the same way every time it is opened.
 */
function compareRows(a: KnownRow, b: KnownRow): number {
  if (a.certainty !== b.certainty) return a.certainty === "certain" ? -1 : 1;
  if (Boolean(a.purpose) !== Boolean(b.purpose)) return a.purpose ? -1 : 1;
  const ad = a.item.uses + a.item.usedBy;
  const bd = b.item.uses + b.item.usedBy;
  if (ad !== bd) return bd - ad;
  if (a.item.name !== b.item.name) return a.item.name < b.item.name ? -1 : 1;
  return a.item.id < b.item.id ? -1 : 1;
}

/**
 * The one sentence about who uses it, counted before the cap.
 *
 * Never 안 쓰여요 and never 0곳: nothing found is a fact about our reading.
 */
export function usedBySentence(side: KnownSide): string {
  if (side.total === 0) return "쓰는 곳을 아직 못 찾았어요.";
  return `${side.total.toLocaleString("ko-KR")}곳에서 쓰여요.`;
}

/** A feature's members, counted before the cap, never as "쓰여요". */
export function membersSentence(side: KnownSide): string {
  if (side.total === 0) return "이 기능으로 묶어 둔 것은 아직 못 찾았어요.";
  return `${side.total.toLocaleString("ko-KR")}개를 이 기능으로 묶어 뒀어요.`;
}

export function usesSentence(side: KnownSide): string {
  if (side.total === 0) return "이 곳이 쓰는 것은 찾지 못했어요.";
  return `${side.total.toLocaleString("ko-KR")}가지를 가져다 써요.`;
}

/** 확실한 연결 3개, 짐작한 연결 1개 — the split, only where there is one. */
export function certaintySplit(side: KnownSide): string | null {
  if (side.total === 0) return null;
  if (side.inferred === 0) return `모두 확실한 연결이에요.`;
  if (side.certain === 0) return `모두 짐작한 연결이에요.`;
  return `확실한 연결 ${side.certain.toLocaleString("ko-KR")}개, 짐작한 연결 ${side.inferred.toLocaleString("ko-KR")}개예요.`;
}
