import type { GraphConnection, GraphItem, ItemKind } from "@/lib/graph/view";

/**
 * A project the size of the one in production, built from nothing.
 *
 * ## Why this exists
 *
 * Every number this renderer was tuned against came from a graph of 68 items —
 * the demo repo — or from a 300-item fixture. Production holds a project of
 * **1,442**. Twenty times the demo is not "the same picture, denser": the
 * packing pitch, the label budget and the link count all move at different
 * rates with the item count, so the only honest way to know what the map does
 * at that size is to build one and count.
 *
 * Imported only by tests. Nothing in the app reaches it, so it costs the bundle
 * nothing — but it lives beside the code it measures rather than in a test
 * file, because the next person to change `lod.ts` needs to be able to
 * re-measure without rebuilding the graph first.
 *
 * ## What "realistic" means here, precisely
 *
 * Three things had to match the real thing or the measurement would be
 * decoration:
 *
 *  1. **The shape of the folder tree.** A real Next.js app is not evenly
 *     spread: `components/` and `lib/` hold most of it, `app/` holds the
 *     routes, and a long tail of small folders holds the rest. An even spread
 *     would give every district the same radius and hide the crowding that
 *     actually happens inside the two big ones.
 *  2. **The degree distribution.** Connections in a codebase are power-law:
 *     a handful of helpers are used everywhere and most things are used once or
 *     twice. `layout.ts` sizes a dot by degree, so a flat distribution would
 *     draw 1,442 identical dots and the item-on-item overlap that the large
 *     ones cause would never appear.
 *  3. **The label lengths.** This is Korean-first and the labels are the thing
 *     that collides. A Hangul syllable is about twice as wide as a Latin
 *     lowercase letter at the same size, so measuring with Latin names would
 *     under-count every overlap by roughly half. Items carry a mix: a plain
 *     Korean `label` where Pass 2 has named one, a Latin file basename or
 *     identifier where it has not.
 *
 * Deterministic by construction — a seeded generator, no clock, no `Math.random`
 * — for the same reason `layout.ts` is: a measurement that lands on different
 * numbers every run is not a measurement.
 */

/** The size of the project in production, which is the number this file exists for. */
export const PRODUCTION_ITEM_COUNT = 1442;

/**
 * mulberry32. Small, fast, and — the only property that matters here —
 * identical on every machine and every run.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where the files are, and what share of them each folder holds.
 *
 * The shares are the shape of a real app rather than a flat spread: measured
 * on this repository's own `src/`, `components` and `lib` between them hold
 * over half of everything, and the rest is a long tail. Two districts holding
 * half the project is exactly the condition the packing has to survive.
 */
const FOLDERS: readonly { dir: string; share: number }[] = [
  { dir: "src/components", share: 0.21 },
  { dir: "src/components/workspace", share: 0.09 },
  { dir: "src/lib", share: 0.16 },
  { dir: "src/lib/graph", share: 0.05 },
  { dir: "src/hooks", share: 0.04 },
  { dir: "src/app", share: 0.08 },
  { dir: "src/app/api", share: 0.05 },
  { dir: "src/store", share: 0.03 },
  { dir: "src/db", share: 0.03 },
  { dir: "src/styles", share: 0.02 },
  { dir: "public/images", share: 0.05 },
  { dir: "tests", share: 0.05 },
  { dir: "docs", share: 0.02 },
  { dir: "scripts", share: 0.02 },
  { dir: "config", share: 0.02 },
  { dir: "src/telemetry", share: 0.04 },
  { dir: "", share: 0.04 },
];

const LATIN_NOUNS = [
  "order", "cart", "payment", "session", "profile", "invoice", "shipping",
  "review", "search", "notification", "coupon", "address", "catalog", "banner",
  "checkout", "wishlist", "receipt", "refund", "inventory", "webhook",
];

const LATIN_VERBS = [
  "build", "fetch", "render", "format", "resolve", "parse", "collect", "apply",
  "normalise", "validate", "summarise", "restore", "persist", "derive",
];

const LATIN_SUFFIXES = [
  "Card", "List", "Panel", "Row", "Badge", "Sheet", "Dialog", "Summary",
  "Provider", "Boundary", "Controller", "Adapter",
];

/**
 * The Korean a Pass 2 run actually writes.
 *
 * Two to seven syllables, which is what `describe.ts` and the feature namer
 * produce. The longest ones are the ones that collide, so they have to be in
 * here at their real frequency rather than as a token long example.
 */
const KOREAN_SUBJECTS = [
  "결제", "로그인", "장바구니", "주문", "회원가입", "상품 목록", "배송지",
  "리뷰", "알림", "검색", "쿠폰", "영수증", "환불", "재고", "관리자",
];

const KOREAN_JOBS = [
  "화면", "버튼", "목록", "저장하기", "불러오기", "확인", "만들기", "고치기",
  "보여주기", "지우기",
];

const PACKAGES = [
  "react", "next", "zod", "drizzle-orm", "tailwindcss", "clsx", "date-fns",
  "lucide-react", "@tanstack/react-query", "framer-motion", "postgres",
  "@radix-ui/react-dialog", "vitest", "eslint", "typescript",
];

const ROUTE_SEGMENTS = [
  "checkout", "cart", "login", "orders", "profile", "search", "products",
  "settings", "admin", "reviews", "coupons", "help",
];

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length) % list.length];
}

/**
 * A degree drawn from a power law, which is what a codebase actually has.
 *
 * `usedBy + uses` decides a dot's radius and a link's rank, so this is the
 * distribution that decides how much of the map is drawn large. An exponent
 * near 2 gives the shape the demo repo has — one `kv` used six times, a hundred
 * things used once.
 */
function powerLawDegree(random: () => number, max: number): number {
  const u = Math.max(random(), 1e-6);
  return Math.min(max, Math.floor(Math.pow(u, -1 / 2.1)) - 1);
}

export type SyntheticProject = {
  items: GraphItem[];
  connections: GraphConnection[];
};

/**
 * @param total How many items to build. Defaults to the production count.
 * @param seed Changing it gives a different project of the same shape, which is
 * how a fix is checked against more than the one graph it was written against.
 */
export function syntheticProject(
  total: number = PRODUCTION_ITEM_COUNT,
  seed = 0x5645_5354,
): SyntheticProject {
  const random = seeded(seed);
  const items: GraphItem[] = [];
  const connections: GraphConnection[] = [];

  /*
   * The split between kinds, taken from what the analyzer emits: a file for
   * every source file, a symbol for every top-level declaration it found (about
   * two per file), a route per page, an endpoint per handler, and a package for
   * every dependency the project reaches for.
   */
  const packageCount = Math.round(total * 0.07);
  const routeCount = Math.round(total * 0.04);
  const endpointCount = Math.round(total * 0.03);
  const remaining = total - packageCount - routeCount - endpointCount;
  const fileCount = Math.round(remaining * 0.35);
  const symbolCount = remaining - fileCount;

  const make = (
    kind: ItemKind,
    name: string,
    path: string | null,
    label: string | null,
  ): GraphItem => {
    const item: GraphItem = {
      id: `${kind}:${items.length}`,
      kind,
      shape: kind === "symbol" ? pick(random, ["component", "function", "hook"]) : null,
      name,
      label,
      summary: null,
      path,
      startLine: path === null ? null : 1,
      endLine: path === null ? null : 40,
      fromUser: false,
      usedBy: 0,
      uses: 0,
    };
    items.push(item);
    return item;
  };

  /** A folder, chosen against the shares above rather than uniformly. */
  const folderFor = (): string => {
    let roll = random();
    for (const folder of FOLDERS) {
      roll -= folder.share;
      if (roll <= 0) return folder.dir;
    }
    return FOLDERS[FOLDERS.length - 1].dir;
  };

  const koreanName = (): string =>
    `${pick(random, KOREAN_SUBJECTS)} ${pick(random, KOREAN_JOBS)}`;

  // Files. About a third carry a Korean label, which is what a finished Pass 2
  // leaves behind on a project this size — the rest are read as basenames.
  const files: GraphItem[] = [];
  for (let i = 0; i < fileCount; i++) {
    const dir = folderFor();
    const base = `${pick(random, LATIN_NOUNS)}${pick(random, LATIN_SUFFIXES)}`;
    const ext = dir.startsWith("public") ? ".png" : dir === "docs" ? ".md" : ".tsx";
    const path = dir === "" ? `${base}${ext}` : `${dir}/${base}-${i}${ext}`;
    files.push(make("file", `${base}-${i}${ext}`, path, random() < 0.32 ? koreanName() : null));
  }

  // Symbols, each cut out of a file, which is where the `contains` edges come
  // from and why a file's district is also its symbols'.
  const symbols: GraphItem[] = [];
  for (let i = 0; i < symbolCount; i++) {
    const owner = files[Math.floor(random() * files.length) % files.length];
    const name =
      random() < 0.5
        ? `${pick(random, LATIN_NOUNS)}${pick(random, LATIN_SUFFIXES)}`
        : `${pick(random, LATIN_VERBS)}${pick(random, LATIN_NOUNS)}`;
    const symbol = make("symbol", name, owner.path, random() < 0.28 ? koreanName() : null);
    symbols.push(symbol);
    connections.push({
      id: `c${connections.length}`,
      from: owner.id,
      to: symbol.id,
      relation: "contains",
      certainty: "certain",
    });
  }

  const routes: GraphItem[] = [];
  for (let i = 0; i < routeCount; i++) {
    const segment = pick(random, ROUTE_SEGMENTS);
    routes.push(
      make(
        "route",
        `/${segment}${i % 3 === 0 ? `/${pick(random, ROUTE_SEGMENTS)}` : ""}`,
        `src/app/${segment}-${i}/page.tsx`,
        random() < 0.6 ? koreanName() : null,
      ),
    );
  }

  const endpoints: GraphItem[] = [];
  for (let i = 0; i < endpointCount; i++) {
    const segment = pick(random, ROUTE_SEGMENTS);
    endpoints.push(
      make(
        "api_endpoint",
        `POST /api/${segment}`,
        `src/app/api/${segment}-${i}/route.ts`,
        random() < 0.5 ? koreanName() : null,
      ),
    );
  }

  const packages: GraphItem[] = [];
  for (let i = 0; i < packageCount; i++) {
    const base = PACKAGES[i % PACKAGES.length];
    packages.push(make("package", i < PACKAGES.length ? base : `${base}-${i}`, null, null));
  }

  const link = (
    from: GraphItem,
    to: GraphItem,
    relation: GraphConnection["relation"],
    certainty: GraphConnection["certainty"],
  ) => {
    if (from.id === to.id) return;
    connections.push({ id: `c${connections.length}`, from: from.id, to: to.id, relation, certainty });
  };

  /*
   * The connections, drawn against the degree distribution rather than
   * uniformly: each file reaches for a number of others drawn from the power
   * law, so a few files are hubs and most are leaves.
   */
  for (const file of files) {
    const out = powerLawDegree(random, 9);
    for (let i = 0; i < out; i++) {
      const target = files[Math.floor(random() * files.length) % files.length];
      link(file, target, "imports", random() < 0.86 ? "certain" : "inferred");
    }
    const used = powerLawDegree(random, 4);
    for (let i = 0; i < used; i++) {
      link(file, packages[Math.floor(random() * packages.length) % packages.length], "uses_package", "certain");
    }
  }

  for (const symbol of symbols) {
    const out = powerLawDegree(random, 7);
    for (let i = 0; i < out; i++) {
      const target = symbols[Math.floor(random() * symbols.length) % symbols.length];
      link(symbol, target, "calls", random() < 0.8 ? "certain" : "inferred");
    }
    if (random() < 0.22) {
      link(symbol, symbols[Math.floor(random() * symbols.length) % symbols.length], "renders", "certain");
    }
  }

  // The one connection that crosses from the screens to the server, which is
  // the one a non-developer asks about by name (D56).
  for (const route of routes) {
    const out = 1 + powerLawDegree(random, 3);
    for (let i = 0; i < out; i++) {
      link(route, endpoints[Math.floor(random() * endpoints.length) % endpoints.length], "fetches", random() < 0.7 ? "certain" : "inferred");
    }
    link(route, files[Math.floor(random() * files.length) % files.length], "renders", "certain");
  }

  // `usedBy`/`uses` are counted from the connections rather than invented, so
  // the radii and the ranks agree with the graph the same way D69 requires.
  const byId = new Map(items.map((one) => [one.id, one]));
  for (const connection of connections) {
    const from = byId.get(connection.from);
    const to = byId.get(connection.to);
    if (from) from.uses++;
    if (to) to.usedBy++;
  }

  return { items, connections };
}
