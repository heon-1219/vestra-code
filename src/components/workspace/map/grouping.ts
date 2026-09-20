import type { GraphConnection, GraphItem, ItemKind } from "@/lib/graph/view";
import { KIND_WORDS } from "@/lib/graph/view";

import { districtOf, type DistrictDescriptor } from "./layout";

/**
 * What counts as a place on the map.
 *
 * `layout.ts` answers *where* territories sit; this file answers *what a
 * territory is*. They were one file while there was only one answer — the
 * top-level folder — and the founder's ask is that there be several: "그래프
 * 클러스터를 파일단위만이 아니라 기능 등 여러 다른 단위들로."
 *
 * ## The rules every grouping obeys
 *
 *  1. **Pure and total.** Same items in, same districts out, in the same order,
 *     for ever. Nothing here reads a clock, a random number, or the DOM.
 *  2. **Nothing ever vanishes.** Every item lands in exactly one district. A
 *     grouping that has no answer for an item puts it in a *named* territory
 *     and says so on the map, because an item that quietly disappears when you
 *     change the view teaches this user that the tool loses their work.
 *  3. **Every district has a name a non-developer reads.** `src/components` is
 *     not a name; 화면 조각 is. A territory called 덩어리 2 is not a name either,
 *     which is what decided the cut recorded further down.
 *  4. **A grouping that degenerates is not offered.** Measured: on the
 *     founder's own portfolio — 58 items, every one a file — grouping by 종류
 *     draws one territory holding all 58 and nothing else. That is not a map,
 *     it is a circle. `groupingOptions` judges each grouping against the real
 *     data and hands the control a sentence saying why, with the numbers in it,
 *     instead of rendering the circle.
 *
 * ## What is here, and what was cut
 *
 * Shipped: **폴더** (the ground truth, and the floor everything falls back to),
 * **기능**, **종류**, **역할**, **쓰임새**.
 *
 * **기능 is built but not yet reachable.** Pass 2 does not exist, so no `feature`
 * item and no `belongs_to` connection has ever been written. The assignment
 * below is complete anyway — including the inheritance through `contains` that
 * D52 relies on — and availability is computed *from the data*, so the option
 * turns itself on the first time a run writes a feature, with no code change.
 * It is offered as unavailable-with-a-reason rather than present-and-empty
 * because present-and-empty means a map with one territory called 아직 묶지 않은
 * 것 holding the whole project: a screen that reads as the product being broken,
 * for a feature that has simply not arrived. One honest sentence costs less.
 *
 * **Cut: 서로 얽힌 정도 (connected components, or community detection over the
 * connections).** Weighed and rejected on three grounds, in order of weight.
 * First, it degenerates by construction: an app is connected — that is what
 * makes it an app — so on the demo repo's 121 connections over 68 items the
 * answer is one component plus a handful of strays, which rule 4 would hide
 * anyway. Second, and worse, community detection *can* split that component,
 * but it cannot name what it finds; the user would get 덩어리 1 · 덩어리 2 · 덩어리
 * 3, which fails rule 3 outright — an unnamed territory is exactly the
 * node-link hairball D59 exists to avoid, only with a fill colour. Third, the
 * question it answers ("what is tangled with what") is already answered, at the
 * moment a person actually asks it, by selecting an item and reading its
 * connections.
 *
 * **쓰임새 is what survived of that idea.** It is built from the same connection
 * counts, it is deterministic and costs nothing, and its three bands name
 * themselves in plain Korean. It also answers the one question D64 promised an
 * answer to — "이 사진, 아무 데서도 안 쓰나요?" — which nothing else on this screen
 * does. Its third band is phrased as 쓰는 곳을 못 찾은 것 and never as "안 쓰는 것":
 * section 3's rule is that we may say we found no connections, and may not turn
 * that into a verdict about the user's code.
 */

export type Grouping = "folder" | "feature" | "kind" | "job" | "usage";

/**
 * What this product says when no `feature` row has been written yet.
 *
 * Exported rather than written inline where `judge` uses it, because a third
 * screen now needs it: 흐름 따라가기's discovery block offers the project's flows
 * grouped by feature where there are features, and has to say the same thing
 * this map says where there are none. `places-panel.tsx` already carries its
 * own variant of this sentence for its own list, and that is two too many —
 * `FLOW_TRACKING.md` §3 asks for this one verbatim on the grounds that two
 * halves of one screen explaining the same gap two different ways is the exact
 * failure the sentence was written to avoid.
 */
export const NO_FEATURES_YET =
  "기능 이름은 아직 붙이기 전이에요. 이름이 붙으면 여기서 기능별로 볼 수 있어요.";

/**
 * The floor. Always available, because it needs nothing but a path, and because
 * a screen with no way to group at all is not a screen we are willing to draw.
 */
export const DEFAULT_GROUPING: Grouping = "folder";

/** Every grouping, in the order the control lists them. */
export const GROUPINGS: readonly Grouping[] = [
  "folder",
  "feature",
  "kind",
  "job",
  "usage",
];

/**
 * What the person switching reads.
 *
 * `meaning` is one sentence, and it is the whole accessibility of this feature:
 * the user may not know what a component is, so the sentence never leans on a
 * word the map itself does not already teach.
 *
 * 역할 rather than 하는 일, deliberately. 기능 and 하는 일 are the same phrase in
 * everyday Korean, and the two groupings mean different things — 기능 is 결제, a
 * part of the product; 역할 is what one piece of code does. Two options a user
 * reads as synonyms is a worse problem than a slightly less colloquial word.
 */
export const GROUPING_WORDS: Record<Grouping, { name: string; meaning: string }> = {
  folder: {
    name: "폴더",
    meaning: "파일이 놓여 있는 자리대로 묶어요.",
  },
  feature: {
    name: "기능",
    meaning: "결제·로그인처럼 앱의 기능별로 묶어요.",
  },
  kind: {
    name: "종류",
    meaning: "파일·페이지·밖에서 가져온 도구처럼, 무엇인지에 따라 묶어요.",
  },
  job: {
    name: "역할",
    meaning: "화면에 보이는 것과 뒤에서 일하는 것을 나눠 묶어요.",
  },
  usage: {
    name: "쓰임새",
    meaning: "여러 곳에서 쓰는 것과, 쓰는 곳을 못 찾은 것을 나눠 묶어요.",
  },
};

/** One territory, with everything in it. */
export type GroupedDistrict = DistrictDescriptor & {
  /**
   * True for the territory that holds what this grouping had no answer for.
   * Judged separately, because a map whose biggest place is "그 밖에" has not
   * grouped anything.
   */
  residual: boolean;
  /**
   * Members, by id ascending — never in arrival order, so that a run streaming
   * its items in a different order produces a byte-identical answer.
   */
  itemIds: readonly string[];
};

export type Grouped = {
  grouping: Grouping;
  /** Largest first, then by name, then by id. Total order, so it is stable. */
  districts: readonly GroupedDistrict[];
  /** Where each item ended up. Every item appears exactly once. */
  byItemId: ReadonlyMap<string, DistrictDescriptor>;
};

/** One row of the control. */
export type GroupingOption = {
  id: Grouping;
  name: string;
  meaning: string;
  available: boolean;
  /**
   * Why not, in one sentence, with this project's own numbers in it. Null when
   * the grouping is available. It is written for the person to *learn something
   * about their project* from — "이 프로젝트는 58개가 전부 파일이에요" is a fact about
   * their site, not an apology from the tool.
   */
  unavailable: string | null;
  /** How many territories this would draw. Shown before anyone commits to it. */
  districtCount: number;
};

/**
 * A grouping is one blob plus dust once this share of everything is in one
 * territory. 0.85 rather than 1.0 because the failure is not only "exactly one
 * district": nine tenths in one circle with four specks around it is the same
 * unreadable picture with more steps.
 */
const CROWDING_LIMIT = 0.85;

/** Below two territories there is nothing to compare, so there is no map. */
const MIN_DISTRICTS = 2;

/**
 * A grouping whose "I don't know" pile is more than half of everything has not
 * answered the question. Half rather than a third: on the demo repo 역할 leaves
 * 30 of 68 items (files, pages, packages — things that have no role to split)
 * outside the four real territories, and those four territories are a genuinely
 * useful picture that a stricter limit would throw away.
 */
const RESIDUE_LIMIT = 0.5;

/** Three or more places is where "this is shared" starts to be worth saying. */
const USED_A_LOT = 3;

type Assignment = {
  byItemId: Map<string, DistrictDescriptor>;
  /** The id of the district holding what this grouping could not place. */
  residualId: string | null;
};

/**
 * Group the project, once.
 *
 * Cost is one or two passes over the items plus one over the connections, on a
 * graph that is a few hundred rows. It is called from a `useMemo`, and it is
 * cheap enough that calling it five times to fill the control is not worth
 * thinking about.
 */
export function groupItems(
  items: readonly GraphItem[],
  connections: readonly GraphConnection[],
  grouping: Grouping,
): Grouped {
  const assignment = assign(items, connections, grouping);

  const districts = new Map<string, { info: DistrictDescriptor; itemIds: string[] }>();
  for (const item of items) {
    const info = assignment.byItemId.get(item.id);
    // Unreachable: every assigner is total. Kept because "an item vanished from
    // the map" is the one failure this file exists to make impossible, and a
    // silent `undefined` here is exactly how it would happen.
    if (!info) continue;
    const existing = districts.get(info.id);
    if (existing) existing.itemIds.push(item.id);
    else districts.set(info.id, { info, itemIds: [item.id] });
  }

  const ordered = [...districts.values()]
    .map<GroupedDistrict>(({ info, itemIds }) => ({
      ...info,
      residual: info.id === assignment.residualId,
      itemIds: [...itemIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }))
    .sort((a, b) => {
      if (a.itemIds.length !== b.itemIds.length) return b.itemIds.length - a.itemIds.length;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

  return { grouping, districts: ordered, byItemId: assignment.byItemId };
}

/**
 * The one thing `layoutMap` wants: which territory this item is in.
 *
 * The fallback is `districtOf`, never nothing — an item the grouping somehow
 * missed falls back to the folder answer, which is always available, rather
 * than off the map.
 */
export function districtLookup(grouped: Grouped): (item: GraphItem) => DistrictDescriptor {
  return (item) => grouped.byItemId.get(item.id) ?? districtOf(item);
}

/** Every grouping, judged against this project's actual shape. */
export function groupingOptions(
  items: readonly GraphItem[],
  connections: readonly GraphConnection[],
): GroupingOption[] {
  return GROUPINGS.map((grouping) => {
    const grouped = groupItems(items, connections, grouping);
    const words = GROUPING_WORDS[grouping];
    const unavailable = judge(grouping, grouped, items);
    return {
      id: grouping,
      name: words.name,
      meaning: words.meaning,
      available: unavailable === null,
      unavailable,
      districtCount: grouped.districts.length,
    };
  });
}

/**
 * The grouping actually to draw.
 *
 * A grouping can stop being available under the same project — re-read a repo,
 * delete every page, and 종류 collapses — and the answer to that must never be a
 * blank centre panel. Falls back to 폴더, which cannot fail.
 */
export function resolveGrouping(
  options: readonly GroupingOption[],
  wanted: Grouping,
): Grouping {
  const found = options.find((option) => option.id === wanted);
  return found?.available ? wanted : DEFAULT_GROUPING;
}

function judge(
  grouping: Grouping,
  grouped: Grouped,
  items: readonly GraphItem[],
): string | null {
  // 폴더 is the floor and is never taken away. Even a project that is one flat
  // folder is honestly drawn that way: that IS what the project looks like.
  if (grouping === "folder") return null;

  const total = items.length;
  if (total === 0) return "아직 읽은 게 없어서 묶어 볼 것도 없어요.";

  if (grouping === "feature" && !items.some((item) => item.kind === "feature")) {
    return NO_FEATURES_YET;
  }

  const largest = grouped.districts[0];
  if (!largest) return "묶어 볼 것이 없어요.";

  if (
    grouped.districts.length < MIN_DISTRICTS ||
    largest.itemIds.length / total >= CROWDING_LIMIT
  ) {
    return `${largest.itemIds.length.toLocaleString("ko-KR")}개가 “${largest.name}” 하나에 몰려 있어서, 이렇게 묶으면 한 덩어리가 돼요.`;
  }

  const residue = grouped.districts.find((district) => district.residual);
  if (residue && residue.itemIds.length / total > RESIDUE_LIMIT) {
    return `절반이 넘는 ${residue.itemIds.length.toLocaleString("ko-KR")}개를 어디에 넣을지 몰라서, 지금은 나눠 보여 드리기 어려워요.`;
  }

  return null;
}

function assign(
  items: readonly GraphItem[],
  connections: readonly GraphConnection[],
  grouping: Grouping,
): Assignment {
  switch (grouping) {
    case "folder":
      return byFolder(items);
    case "feature":
      return byFeature(items, connections);
    case "kind":
      return byKind(items);
    case "job":
      return byJob(items);
    case "usage":
      return byUsage(items);
  }
}

/**
 * Today's map, unchanged.
 *
 * `districtOf` stays in `layout.ts` rather than moving here: the left panel
 * imports it directly to headline its list with the same territories the map
 * draws, and moving it would edit a file this work has no business editing.
 */
function byFolder(items: readonly GraphItem[]): Assignment {
  const byItemId = new Map<string, DistrictDescriptor>();
  for (const item of items) byItemId.set(item.id, districtOf(item));
  return { byItemId, residualId: "elsewhere" };
}

const FEATURE_NONE: DistrictDescriptor = {
  id: "feature:none",
  name: "아직 묶지 않은 것",
  folder: "어느 기능인지 몰라요",
};

/**
 * Districts are the features themselves.
 *
 * Nothing reaches this yet — Pass 2 writes the first `feature` item — but the
 * three things that will bite on the day it does are handled here rather than
 * discovered then:
 *
 *   - **A piece takes its file's feature.** D52: the LLM is asked about files
 *     only, and symbols inherit through Pass 1's `contains`. Without this, the
 *     first feature map would be 22 files in named territories and 38 pieces
 *     piled in 아직 묶지 않은 것.
 *   - **One home each.** UI_DIRECTION section 5, warning 3: a helper that three
 *     features claim must live in exactly one of them or the territories
 *     interpenetrate. It goes to the feature claiming the most, ties broken by
 *     id — deterministic, and never a coin flip.
 *   - **Direction is not assumed.** `belongs_to` is written member → feature,
 *     but the feature is found by looking at which end *is* a feature rather
 *     than by trusting the arrow.
 */
function byFeature(
  items: readonly GraphItem[],
  connections: readonly GraphConnection[],
): Assignment {
  const features = new Map<string, GraphItem>();
  for (const item of items) {
    if (item.kind === "feature") features.set(item.id, item);
  }

  const claims = new Map<string, string[]>();
  const claim = (memberId: string, featureId: string) => {
    const list = claims.get(memberId);
    if (!list) claims.set(memberId, [featureId]);
    else if (!list.includes(featureId)) list.push(featureId);
  };

  for (const connection of connections) {
    if (connection.relation !== "belongs_to") continue;
    const featureId = features.has(connection.to)
      ? connection.to
      : features.has(connection.from)
        ? connection.from
        : null;
    if (!featureId) continue;
    const memberId = featureId === connection.to ? connection.from : connection.to;
    if (memberId === featureId) continue;
    claim(memberId, featureId);
  }

  // Inheritance reads from a snapshot of the direct claims and writes to the
  // live map, so the result cannot depend on the order connections arrive in.
  const direct = new Map(claims);
  for (const connection of connections) {
    if (connection.relation !== "contains") continue;
    if (direct.has(connection.to)) continue;
    const parent = direct.get(connection.from);
    if (parent) claims.set(connection.to, [...parent]);
  }

  const weight = new Map<string, number>();
  for (const list of claims.values()) {
    for (const featureId of list) weight.set(featureId, (weight.get(featureId) ?? 0) + 1);
  }

  const descriptorOf = (feature: GraphItem): DistrictDescriptor => ({
    id: `feature:${feature.id}`,
    name: feature.label ?? feature.name,
    // Where the name came from, which for a feature is either us or the person.
    folder: feature.fromUser ? "직접 붙인 이름" : "기능",
  });

  const byItemId = new Map<string, DistrictDescriptor>();
  for (const item of items) {
    // A feature is its own territory rather than a dot inside someone else's.
    const self = features.get(item.id);
    if (self) {
      byItemId.set(item.id, descriptorOf(self));
      continue;
    }

    const list = claims.get(item.id);
    if (!list || list.length === 0) {
      byItemId.set(item.id, FEATURE_NONE);
      continue;
    }

    const home = [...list].sort((a, b) => {
      const byWeight = (weight.get(b) ?? 0) - (weight.get(a) ?? 0);
      if (byWeight !== 0) return byWeight;
      return a < b ? -1 : 1;
    })[0];

    const feature = features.get(home);
    byItemId.set(item.id, feature ? descriptorOf(feature) : FEATURE_NONE);
  }

  return { byItemId, residualId: FEATURE_NONE.id };
}

/**
 * The small line under each name.
 *
 * The renderer draws `${count}개 · ${folder}`, so this is a short phrase and
 * never a sentence. It exists because the name alone is a claim: 조각 means
 * nothing until something says it is a piece cut out of a file.
 */
const KIND_NOTES: Record<ItemKind, string> = {
  file: "프로젝트 안의 파일",
  symbol: "파일 안의 조각",
  route: "사람이 여는 화면",
  api_endpoint: "서버가 받는 곳",
  package: "밖에서 가져온 것",
  feature: "붙여 준 이름",
};

function byKind(items: readonly GraphItem[]): Assignment {
  const byItemId = new Map<string, DistrictDescriptor>();
  for (const item of items) {
    byItemId.set(item.id, {
      id: `kind:${item.kind}`,
      name: KIND_WORDS[item.kind],
      folder: KIND_NOTES[item.kind],
    });
  }
  // Every item has a kind, so nothing is ever left over.
  return { byItemId, residualId: null };
}

/**
 * A piece's job, from its `shape`.
 *
 * **Only pieces.** A file, a page, a package have no role to split, and the
 * temptation — reading a role off the extension, so that `.css` becomes 꾸미기
 * and `.js` becomes 일 처리 — is a guess dressed as a fact: a `.js` file can be
 * anything at all. They go to a named territory that says we did not split
 * them, and on a project with too few pieces this grouping hides itself rather
 * than drawing that pile as if it were an answer.
 */
const JOB_WORDS: Record<string, DistrictDescriptor | undefined> = {
  component: { id: "job:component", name: "화면 조각", folder: "화면에 보이는 것" },
  hook: { id: "job:hook", name: "화면 도우미", folder: "화면을 돕는 것" },
  function: { id: "job:function", name: "일 처리", folder: "불러서 쓰는 것" },
  class: { id: "job:class", name: "설계도", folder: "찍어내는 틀" },
  type: { id: "job:type", name: "정해 둔 모양", folder: "데이터의 모양" },
  style_rule: { id: "job:style", name: "꾸미기", folder: "보이는 모습" },
};

const JOB_OTHER: DistrictDescriptor = {
  id: "job:other",
  name: "그 밖에",
  folder: "역할을 나누기 어려워요",
};

function byJob(items: readonly GraphItem[]): Assignment {
  const byItemId = new Map<string, DistrictDescriptor>();
  for (const item of items) {
    const job = item.shape ? JOB_WORDS[item.shape] : undefined;
    byItemId.set(item.id, job ?? JOB_OTHER);
  }
  return { byItemId, residualId: JOB_OTHER.id };
}

/**
 * How many places use it.
 *
 * `usedBy` rather than a fresh count over the connections, because D69 already
 * settled what counts as a use — `contains` and `belongs_to` are structure, not
 * use — and because the right panel says "N곳에서 쓰여요" from the same number. A
 * map that sorted an item into 한두 곳 while the panel beside it said 6곳 would be
 * two answers to one question.
 */
const USAGE_BANDS: readonly { from: number; district: DistrictDescriptor }[] = [
  {
    from: USED_A_LOT,
    district: { id: "usage:many", name: "여러 곳에서 쓰는 것", folder: "3곳 이상" },
  },
  {
    from: 1,
    district: { id: "usage:few", name: "한두 곳에서 쓰는 것", folder: "1–2곳" },
  },
  {
    from: 0,
    // Never "안 쓰는 것". We know what the map holds, and nothing more; section
    // 3 lets us say we found no connections and does not let us turn that into
    // a verdict on the user's code.
    district: { id: "usage:none", name: "쓰는 곳을 못 찾은 것", folder: "연결이 없어요" },
  },
];

function byUsage(items: readonly GraphItem[]): Assignment {
  const byItemId = new Map<string, DistrictDescriptor>();
  for (const item of items) {
    const band =
      USAGE_BANDS.find((candidate) => item.usedBy >= candidate.from) ??
      USAGE_BANDS[USAGE_BANDS.length - 1];
    byItemId.set(item.id, band.district);
  }
  // No residue: 쓰는 곳을 못 찾은 것 is an answer, and on a site full of photos it
  // is the most useful one on the screen. It is not the pile of things we could
  // not place, so it is not judged as one — only the crowding limit applies.
  return { byItemId, residualId: null };
}
