import type { GraphItem } from "@/lib/graph/view";

/**
 * Where every district and every item sits on the map.
 *
 * Pure: items in, positions out. No canvas, no React, no clock, no randomness.
 * That is the whole point of keeping it in its own file — the resting screen is
 * the product's signature picture, and a picture that lands differently on
 * every run cannot be screenshotted, cannot be reviewed, and cannot be trusted
 * by the person watching their own project appear.
 *
 * **Deliberately not a force simulation.** D59's district map exists to avoid
 * the hairball, and a physics layout is how you get one: it costs CPU forever,
 * settles somewhere new every time, and gives no guarantee at all that a
 * feature's members end up next to each other (UI_DIRECTION section 5, warning
 * 3 — the interpenetrating hulls). Packing named territories on a deterministic
 * spiral gives non-overlap **by construction** rather than by hope, renders
 * identically every time, and costs nothing at rest.
 *
 * **What counts as a district is handed in, not decided here.** `layoutMap`
 * takes the function that answers "which territory is this item in", and
 * `grouping.ts` holds the answers — folder, feature, kind, role, how much a
 * thing is used. The default is the folder, which is where this started and
 * the one answer that needs nothing but a path. Everything below the
 * assignment is indifferent to which grouping produced it: territories are
 * packed, items are packed inside them, and the picture is the same shape
 * whatever named the places.
 *
 * Every district carries the line shown under its name — for the folder
 * grouping that is the folder it was read from — so the Korean name is never a
 * bare claim about what the code does.
 */

/** A district before it has a position. */
export type DistrictDescriptor = {
  /**
   * Stable key, derived from the folder rather than from its Korean name, so
   * renaming a district in the table below does not repoint anything. Same
   * reasoning as D55: a name is text a person reads, never an identity.
   */
  id: string;
  /** What a person reads, lying flat on the territory. */
  name: string;
  /** Where the name came from. Shown small, so the name is never a claim. */
  folder: string;
};

export type PlacedDistrict = DistrictDescriptor & {
  x: number;
  y: number;
  r: number;
  /** How many items live here. Shown under the name. */
  count: number;
  /**
   * Index into the renderer's cluster hues.
   *
   * Chosen so that no territory sits next to another wearing the same colour —
   * see `pickHue`. It used to be the size rank modulo six, which is fine for
   * six places and wrong for seven: the seventh territory is the seventh
   * largest, which the packing puts in the outer ring where the first one's
   * neighbours are, and two same-coloured blobs touching is the one thing
   * colour-as-grouping cannot survive.
   */
  hue: number;
};

export type PlacedItem = {
  id: string;
  districtId: string;
  x: number;
  y: number;
  /** World radius. Grows with how connected the item is. */
  r: number;
};

export type MapLayout = {
  districts: PlacedDistrict[];
  items: PlacedItem[];
  byItemId: Map<string, PlacedItem>;
  byDistrictId: Map<string, PlacedDistrict>;
  /** The whole map's extent, for fitting it into a container. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /**
   * The area the items actually occupy, in world units squared.
   *
   * **Not the bounding box, and the difference is not small.** Every
   * level-of-detail rule in `render/lod.ts` asks "how much of the map is on
   * screen at this zoom", and answers it by dividing the viewport's area by the
   * map's. Measured on a 1,442-item project, the bounding box is **3.9 times**
   * the area the packing actually puts items in — districts are discs with gaps
   * between them, sitting inside a rectangle. So every density estimate was
   * nearly four times too optimistic, and every budget derived from one was
   * overshot by the same factor: 36 names became 139 on screen, and 28 relation
   * words became 786.
   *
   * Summed from the packing's own footprint rather than measured from the
   * placed items, so it is exact, costs nothing, and cannot drift from where
   * the items were actually put.
   */
  itemArea: number;
};

/** How many hues the renderer has. Districts past this reuse them. */
export const DISTRICT_HUE_COUNT = 6;

/**
 * Below this many members a territory has no hub.
 *
 * A hub is "the busiest thing in a crowd"; with three items there is no crowd,
 * and drawing one of them at nearly twice the size would be claiming an
 * importance the numbers do not support.
 *
 * It lives here rather than in `render/scene.ts`, where it was, for one
 * measured reason: **the packing has to know which item will be drawn large, or
 * it cannot leave room for it.** See `HUB_BOOST`.
 */
export const HUB_MIN_MEMBERS = 4;

/**
 * The extra reach a district's busiest item is drawn with.
 *
 * The reference overview the founder sent is eight neighbourhoods, each one a
 * large node with dozens of small ones around it. Ours earns that shape rather
 * than decorating it: the large node is the most-connected thing in the
 * territory, and because the boost applies to the radius the alpha rule is fed,
 * it is also the last item to fade as you zoom out.
 *
 * **It is a layout constant, not a drawing one, and that was the bug.** It used
 * to live in `render/lod.ts` and be applied at draw time to a slot the packing
 * had sized for the unboosted radius, so the hub's circle simply grew over its
 * neighbours. Measured on a 1,442-item project at the resting zoom: **seven
 * pairs of overlapping dots with hubs and zero without** — every single
 * item-on-item overlap on the map was this constant, and none of it was the
 * packing. The packing now reserves the room, and the hub sits in the middle of
 * its territory with a clear ring around it, which is what the reference
 * picture has anyway.
 */
export const HUB_BOOST = 1.9;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * World units between packed items.
 *
 * Exported because the renderer needs it to answer "is there room to write a
 * name beside this dot yet": the pitch between two items on screen is this
 * number times the zoom, and a name that does not fit between two dots is a
 * name lying on top of its neighbour.
 */
export const ITEM_SPACING = 13;
const ITEM_R_MIN = 3.4;
const ITEM_R_MAX = 9;

/** Breathing room inside a district's rim, and between two districts. */
const DISTRICT_PAD = 22;
const DISTRICT_MIN_R = 54;
const DISTRICT_GAP = 26;

/** Spiral step for placing districts. Smaller packs tighter and costs more. */
const PLACE_STEP = 17;

/**
 * Districts are placed on a slightly flattened spiral because the map lives in
 * the wide centre panel of the workspace, never in a square.
 */
const PLACE_SQUASH = 0.82;

/**
 * Items sit in the lower part of their territory so the name has the top of it
 * to itself. A map label that fights the things it labels is unreadable, and
 * the alternative — a floating pill over the map — is the node-link chrome the
 * direction exists to avoid.
 */
const ITEM_BAND_SQUASH = 0.70;
const ITEM_BAND_DROP = 0.20;

/**
 * Folder → the place it is part of.
 *
 * Two levels rather than one, because several folders are the same PLACE.
 * `public/`, `images/` and `assets/fonts/` are all "the pictures and files",
 * and a map with three identically named territories on it is a map nobody can
 * read — measured on a portfolio site, which produced two districts both called
 * 이미지·파일 side by side. They merge into one, and the district then names every
 * folder it covers so the merge is visible rather than quietly assumed.
 *
 * The bucket id is a latin slug and never the Korean name: D55's rule, that a
 * name is text a person reads and never an identity, applies here too.
 */
const FOLDER_BUCKETS: Record<string, string | undefined> = {
  "": "root",
  app: "screens",
  pages: "screens",
  routes: "screens",
  views: "screens",
  screens: "screens",
  "app/api": "endpoints",
  "pages/api": "endpoints",
  "src/api": "endpoints",
  api: "endpoints",
  server: "server",
  components: "pieces",
  component: "pieces",
  ui: "pieces",
  widgets: "pieces",
  lib: "shared",
  libs: "shared",
  util: "shared",
  utils: "shared",
  helpers: "shared",
  shared: "shared",
  common: "shared",
  core: "shared",
  hooks: "shared",
  services: "shared",
  db: "data",
  database: "data",
  data: "data",
  models: "data",
  schema: "data",
  prisma: "data",
  drizzle: "data",
  migrations: "data",
  store: "state",
  stores: "state",
  state: "state",
  context: "state",
  styles: "styling",
  style: "styling",
  css: "styling",
  scss: "styling",
  public: "assets",
  static: "assets",
  assets: "assets",
  images: "assets",
  img: "assets",
  media: "assets",
  fonts: "assets",
  test: "tests",
  tests: "tests",
  __tests__: "tests",
  spec: "tests",
  e2e: "tests",
  cypress: "tests",
  docs: "docs",
  doc: "docs",
  scripts: "tooling",
  bin: "tooling",
  tools: "tooling",
  config: "config",
  locales: "i18n",
  i18n: "i18n",
  messages: "i18n",
  features: "features",
  modules: "features",
  domains: "features",
  legacy: "legacy",
};

/**
 * The place → the plain Korean a person reads.
 *
 * Every name here is an everyday word, not a translation of the folder. `lib`
 * is not "라이브러리"; it is 공용 기능, because the user we are writing for has never
 * had a reason to learn either word. A folder we do not recognise keeps its own
 * name rather than being swept into 기타 — the user (or their agent) chose that
 * name, and it means more to them than anything we could invent for it.
 */
const PLACE_WORDS: Record<string, string | undefined> = {
  root: "맨 위",
  screens: "화면",
  endpoints: "서버 주소",
  server: "서버",
  pieces: "화면 조각",
  shared: "공용 기능",
  data: "데이터",
  state: "상태",
  styling: "스타일",
  assets: "이미지·파일",
  tests: "테스트",
  docs: "문서",
  tooling: "도구",
  config: "설정",
  i18n: "번역",
  features: "기능 묶음",
  legacy: "예전 코드",
};

/**
 * Folders that are a container for the real folder rather than a place
 * themselves. `src/components` and `components` are the same district, because
 * to the person reading the map they are the same thing.
 */
const TRANSPARENT_ROOTS = new Set(["src", "source", "app/src"]);

/** Two-segment folders that mean something different from their first segment. */
const TWO_SEGMENT_KEYS = new Set(["app/api", "pages/api", "src/api"]);

function directoryOf(path: string): string {
  const cleaned = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const cut = cleaned.lastIndexOf("/");
  return cut === -1 ? "" : cleaned.slice(0, cut);
}

/**
 * Which district an item belongs to, and what that district is called.
 *
 * Symbols need no special case: a symbol carries its file's path, so it lands
 * in the same territory as the file it was cut out of.
 */
export function districtOf(item: GraphItem): DistrictDescriptor {
  if (item.kind === "package") {
    // A package has no path at all. It is not in the project; it is a thing the
    // project reaches for, which is why it gets a territory of its own rather
    // than being scattered through the ones that use it.
    return { id: "packages", name: "외부 도구", folder: "package.json" };
  }
  if (item.kind === "feature") {
    // Pass 2 does not run yet, so nothing reaches this today. When it does,
    // features become districts in their own right and this file changes shape.
    return { id: "features", name: "기능", folder: "" };
  }
  if (!item.path) {
    return { id: "elsewhere", name: "그 밖에", folder: "" };
  }

  const dir = directoryOf(item.path);
  const segments = dir === "" ? [] : dir.split("/");

  // Strip the wrapper folder first, so `src/components` and `components` are
  // one district rather than two that mean the same thing.
  const stripped =
    segments.length > 0 && TRANSPARENT_ROOTS.has(segments[0])
      ? segments.slice(1)
      : segments;

  if (stripped.length === 0) {
    return { id: "place:root", name: "맨 위", folder: "/" };
  }

  const twoSegment = stripped.length > 1 ? `${stripped[0]}/${stripped[1]}` : "";
  const key = TWO_SEGMENT_KEYS.has(twoSegment) ? twoSegment : stripped[0];
  const bucket = FOLDER_BUCKETS[key];

  // An unrecognised folder is its own place and keeps the name its owner gave
  // it, rather than being swept into 기타 with everything else we did not expect.
  if (!bucket) return { id: `dir:${key}`, name: stripped[0], folder: `${key}/` };

  return { id: `place:${bucket}`, name: PLACE_WORDS[bucket] ?? stripped[0], folder: `${key}/` };
}

/** How large an item draws. More connections, larger dot. */
function itemRadius(item: GraphItem): number {
  const degree = item.usedBy + item.uses;
  const t = Math.min(1, Math.sqrt(degree) / 6);
  return ITEM_R_MIN + t * (ITEM_R_MAX - ITEM_R_MIN);
}

/**
 * The first sunflower slot a hub's neighbours may use.
 *
 * Solved from the constants rather than picked, because picking is how the
 * overlap got here. The hub sits at the middle of the packing and is drawn at
 * `ITEM_R_MAX * HUB_BOOST`; the nearest neighbour is drawn at up to
 * `ITEM_R_MAX`; so the first ring has to stand at least the sum of those, plus
 * a pixel of daylight, away from the middle. The **squashed** distance is what
 * counts — the band is compressed vertically, so a neighbour directly above the
 * hub is `ITEM_BAND_SQUASH` of the way out that a neighbour beside it is, and
 * sizing against the unsquashed radius would leave the ring clear to the sides
 * and overlapping top and bottom.
 */
const HUB_CLEARANCE = ITEM_R_MAX * HUB_BOOST + ITEM_R_MAX + 1;
const HUB_FIRST_SLOT = (() => {
  let slot = 1;
  while (ITEM_SPACING * Math.sqrt(slot + 0.5) * ITEM_BAND_SQUASH < HUB_CLEARANCE) slot++;
  return slot;
})();

/**
 * How many sunflower slots a territory uses, which is more than its member
 * count when it has a hub to leave room around.
 */
function slotsFor(count: number, hasHub: boolean): number {
  return hasHub ? HUB_FIRST_SLOT + Math.max(count - 1, 0) : count;
}

/** How far out the outermost item in a territory sits. */
function packRadius(count: number, hasHub: boolean): number {
  return ITEM_SPACING * Math.sqrt(Math.max(slotsFor(count, hasHub), 1));
}

function districtRadius(count: number, hasHub: boolean): number {
  return Math.max(
    DISTRICT_MIN_R,
    packRadius(count, hasHub) + ITEM_R_MAX + DISTRICT_PAD,
  );
}

/**
 * Which member of a territory is drawn as its hub.
 *
 * By `usedBy + uses`, ties to the lower id — **the same rule, written the same
 * way, as `hubsOf` in `render/scene.ts`**, because the packing reserves the room
 * and the renderer spends it, and two rules that disagree would put the boosted
 * circle somewhere no room was left. A territory below `HUB_MIN_MEMBERS` has no
 * hub and therefore needs no room, which is the same threshold on both sides.
 */
function hubIndexOf(members: readonly GraphItem[]): number {
  if (members.length < HUB_MIN_MEMBERS) return -1;
  let best = 0;
  let bestDegree = members[0].usedBy + members[0].uses;
  for (let i = 1; i < members.length; i++) {
    const degree = members[i].usedBy + members[i].uses;
    if (degree > bestDegree || (degree === bestDegree && members[i].id < members[best].id)) {
      best = i;
      bestDegree = degree;
    }
  }
  return best;
}

/**
 * Sorting an item collection into one canonical order.
 *
 * Path first, so files that sit next to each other in the project sit next to
 * each other on the map. Id last so the order is total: a run that streams its
 * items in a different order still produces the identical picture, which is
 * what makes "refresh mid-run without losing state" look like nothing happened.
 */
function canonicalOrder(a: GraphItem, b: GraphItem): number {
  const pathA = a.path ?? "";
  const pathB = b.path ?? "";
  if (pathA !== pathB) return pathA < pathB ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * @param districtFor Which territory each item belongs to. Defaults to the
 * folder reading above; `grouping.ts` supplies the others. It must be total —
 * an item it has no answer for would be an item that vanished off the map.
 */
export function layoutMap(
  items: readonly GraphItem[],
  districtFor: (item: GraphItem) => DistrictDescriptor = districtOf,
): MapLayout {
  const sorted = [...items].sort(canonicalOrder);

  const groups = new Map<
    string,
    { info: DistrictDescriptor; folders: Set<string>; members: GraphItem[] }
  >();
  for (const item of sorted) {
    const info = districtFor(item);
    const existing = groups.get(info.id);
    if (existing) {
      existing.members.push(item);
      existing.folders.add(info.folder);
    } else {
      groups.set(info.id, { info, folders: new Set([info.folder]), members: [item] });
    }
  }

  // Largest first: the biggest territory takes the centre, which is both how a
  // real map reads and what makes the greedy placement below pack tightly.
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.members.length !== b.members.length) return b.members.length - a.members.length;
    if (a.info.name !== b.info.name) return a.info.name < b.info.name ? -1 : 1;
    return a.info.id < b.info.id ? -1 : 1;
  });

  const districts: PlacedDistrict[] = [];
  const placedItems: PlacedItem[] = [];

  let itemArea = 0;

  for (const group of ordered) {
    const hubIndex = hubIndexOf(group.members);
    const hasHub = hubIndex >= 0;
    const r = districtRadius(group.members.length, hasHub);
    const spot = findSpot(districts, r);
    const district: PlacedDistrict = {
      ...group.info,
      folder: describeFolders(group.folders),
      x: spot.x,
      y: spot.y,
      r,
      count: group.members.length,
      hue: pickHue(districts, spot.x, spot.y),
    };
    districts.push(district);

    /*
     * Sunflower packing: even density, no gaps, no two items on top of each
     * other, and a slot's place does not depend on any other item's size.
     *
     * The hub takes the middle and the rest start at `HUB_FIRST_SLOT`, leaving
     * the boosted circle a clear ring. Order is otherwise untouched — the k-th
     * remaining member is still the k-th in canonical order — so the picture is
     * the same picture, with the busiest thing moved to the middle of its own
     * territory where the reference overview puts it.
     */
    let slot = hasHub ? HUB_FIRST_SLOT : 0;
    for (const [k, item] of group.members.entries()) {
      const mine = hasHub && k === hubIndex ? 0 : slot++;
      const angle = mine * GOLDEN_ANGLE;
      const radius = ITEM_SPACING * Math.sqrt(mine + 0.5);
      const placed: PlacedItem = {
        id: item.id,
        districtId: district.id,
        x: district.x + Math.cos(angle) * radius,
        y: district.y + Math.sin(angle) * radius * ITEM_BAND_SQUASH + r * ITEM_BAND_DROP,
        r: itemRadius(item),
      };
      placedItems.push(placed);
    }

    // The ellipse the packing above actually fills, which is what every density
    // rule in `render/lod.ts` has to divide by. An empty territory contributes
    // nothing, because nothing is in it.
    const pack = packRadius(group.members.length, hasHub);
    itemArea += Math.PI * pack * pack * ITEM_BAND_SQUASH;
  }

  const bounds = boundsOf(districts);

  return {
    districts,
    items: placedItems,
    byItemId: new Map(placedItems.map((item) => [item.id, item])),
    byDistrictId: new Map(districts.map((district) => [district.id, district])),
    bounds,
    itemArea,
  };
}

/**
 * The first point on a flattened golden-angle spiral where this district fits
 * without touching one already placed.
 *
 * Greedy and deterministic. The spiral is scanned outward, so a district lands
 * as close to the centre as it can — which keeps the map compact without any
 * of the settling a simulation would need to do.
 */
function findSpot(
  placed: readonly PlacedDistrict[],
  r: number,
): { x: number; y: number } {
  if (placed.length === 0) return { x: 0, y: 0 };

  const attempts = 4000 + placed.length * 400;
  for (let k = 0; k < attempts; k++) {
    const angle = k * GOLDEN_ANGLE;
    const radius = PLACE_STEP * Math.sqrt(k);
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius * PLACE_SQUASH;
    let clear = true;
    for (const other of placed) {
      const dx = x - other.x;
      const dy = y - other.y;
      const need = r + other.r + DISTRICT_GAP;
      if (dx * dx + dy * dy < need * need) {
        clear = false;
        break;
      }
    }
    if (clear) return { x, y };
  }

  // Unreachable for any repo we can render, but a layout that throws would take
  // the whole screen with it. Park it to the right of everything placed.
  let far = 0;
  for (const other of placed) far = Math.max(far, other.x + other.r);
  return { x: far + DISTRICT_GAP + r, y: 0 };
}

/**
 * The colour this territory wears, given where it landed.
 *
 * The hue with the most room around it: for each of the six, how far away the
 * nearest territory already wearing it is, and the winner is the largest of
 * those distances. Ties go to the lowest index, so a fresh map still reads
 * c1, c2, c3… in size order and the first six are always all different.
 *
 * Greedy and deterministic, like everything else here. It is O(districts × 6)
 * per placement on a list that is tens long, which is nothing next to the
 * spiral scan it runs beside.
 */
function pickHue(placed: readonly PlacedDistrict[], x: number, y: number): number {
  let best = 0;
  let bestRoom = -1;
  for (let hue = 0; hue < DISTRICT_HUE_COUNT; hue++) {
    let room = Infinity;
    for (const other of placed) {
      if (other.hue !== hue) continue;
      room = Math.min(room, Math.hypot(other.x - x, other.y - y));
    }
    if (room > bestRoom) {
      bestRoom = room;
      best = hue;
    }
  }
  return best;
}

/**
 * The folders a district covers, written out for the line under its name.
 *
 * Every one of them when there are few, and a count past that: the name is a
 * reading of these folders, so hiding which ones would make it a bare claim.
 */
function describeFolders(folders: ReadonlySet<string>): string {
  const sorted = [...folders].sort();
  if (sorted.length <= 2) return sorted.join(", ");
  return `${sorted[0]}, ${sorted[1]} 외 ${sorted.length - 2}곳`;
}

function boundsOf(districts: readonly PlacedDistrict[]): MapLayout["bounds"] {
  if (districts.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of districts) {
    minX = Math.min(minX, d.x - d.r);
    minY = Math.min(minY, d.y - d.r);
    maxX = Math.max(maxX, d.x + d.r);
    maxY = Math.max(maxY, d.y + d.r);
  }
  return { minX, minY, maxX, maxY };
}
