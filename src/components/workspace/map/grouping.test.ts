import { describe, expect, it } from "vitest";

import type { GraphConnection, GraphItem } from "@/lib/graph/view";

import {
  DEFAULT_GROUPING,
  GROUPINGS,
  GROUPING_WORDS,
  districtLookup,
  groupItems,
  groupingOptions,
  resolveGrouping,
  type Grouping,
} from "./grouping";
import { layoutMap } from "./layout";

function item(partial: Partial<GraphItem> & { id: string }): GraphItem {
  return {
    kind: "file",
    shape: null,
    name: partial.path ?? partial.id,
    label: null,
    summary: null,
    path: null,
    startLine: null,
    endLine: null,
    fromUser: false,
    usedBy: 0,
    uses: 0,
    ...partial,
  };
}

function link(
  from: string,
  to: string,
  relation: GraphConnection["relation"],
): GraphConnection {
  return { id: `${from}->${to}:${relation}`, from, to, relation, certainty: "certain" };
}

/**
 * The demo repo's shape, shrunk.
 *
 * Measured there: 68 items, of which 38 are pieces and 30 are not. The ratio is
 * the part that has to survive the shrinking, because it is what decides
 * whether 역할 is drawable — a fixture with a handful of pieces and a crowd of
 * files would hide 역할 here while it shows on the repo this is a model of.
 */
const shop: GraphItem[] = [
  item({ id: "f-page", path: "src/app/checkout/page.tsx", kind: "route", usedBy: 0 }),
  item({ id: "f-api", path: "src/app/api/orders/route.ts", kind: "api_endpoint" }),
  item({ id: "f-pay", path: "src/components/PayButton.tsx" }),
  item({ id: "f-price", path: "src/components/PriceTag.tsx" }),
  item({ id: "f-cart", path: "src/lib/cart.ts" }),
  item({ id: "f-format", path: "src/lib/format.ts", usedBy: 6 }),
  item({
    id: "s-pay",
    kind: "symbol",
    shape: "component",
    name: "PayButton",
    path: "src/components/PayButton.tsx",
    usedBy: 2,
  }),
  item({
    id: "s-price",
    kind: "symbol",
    shape: "component",
    name: "PriceTag",
    path: "src/components/PriceTag.tsx",
    usedBy: 1,
  }),
  item({
    id: "s-usecart",
    kind: "symbol",
    shape: "hook",
    name: "useCart",
    path: "src/lib/cart.ts",
    usedBy: 4,
  }),
  item({
    id: "s-format",
    kind: "symbol",
    shape: "function",
    name: "formatPrice",
    path: "src/lib/format.ts",
    usedBy: 4,
  }),
  item({
    id: "s-order",
    kind: "symbol",
    shape: "type",
    name: "Order",
    path: "src/lib/cart.ts",
    usedBy: 3,
  }),
  item({
    id: "s-checkout",
    kind: "symbol",
    shape: "component",
    name: "CheckoutPage",
    path: "src/app/checkout/page.tsx",
  }),
  item({
    id: "s-total",
    kind: "symbol",
    shape: "function",
    name: "total",
    path: "src/lib/cart.ts",
    usedBy: 2,
  }),
  item({
    id: "s-addtocart",
    kind: "symbol",
    shape: "function",
    name: "addToCart",
    path: "src/lib/cart.ts",
    usedBy: 3,
  }),
  item({
    id: "s-money",
    kind: "symbol",
    shape: "type",
    name: "Money",
    path: "src/lib/format.ts",
    usedBy: 1,
  }),
  item({
    id: "s-postorder",
    kind: "symbol",
    shape: "function",
    name: "POST",
    path: "src/app/api/orders/route.ts",
  }),
  item({ id: "pkg-react", kind: "package", name: "react", usedBy: 5 }),
  item({ id: "f-logo", path: "public/logo.png" }),
  item({ id: "f-root", path: "package.json" }),
];

const shopLinks: GraphConnection[] = [
  link("f-pay", "s-pay", "contains"),
  link("f-price", "s-price", "contains"),
  link("f-cart", "s-usecart", "contains"),
  link("f-cart", "s-order", "contains"),
  link("f-cart", "s-total", "contains"),
  link("f-cart", "s-addtocart", "contains"),
  link("f-format", "s-format", "contains"),
  link("f-format", "s-money", "contains"),
  link("f-page", "s-checkout", "contains"),
  link("f-api", "s-postorder", "contains"),
  link("s-pay", "s-format", "calls"),
  link("s-pay", "s-usecart", "calls"),
];

/**
 * The founder's own portfolio: every item a file, no pieces at all. The shape
 * that breaks a design which quietly assumes components exist.
 */
const portfolio: GraphItem[] = [
  ...Array.from({ length: 3 }, (_, i) => item({ id: `p-html${i}`, path: `page${i}.html` })),
  ...Array.from({ length: 20 }, (_, i) =>
    item({ id: `p-img${i}`, path: `assets/photo${i}.jpg`, usedBy: i < 12 ? 1 : 0 }),
  ),
  ...Array.from({ length: 6 }, (_, i) =>
    item({ id: `p-css${i}`, path: `css/part${i}.css`, usedBy: 2 }),
  ),
];

function everyItemPlacedOnce(items: readonly GraphItem[], grouping: Grouping) {
  const grouped = groupItems(items, shopLinks, grouping);
  const seen = new Set<string>();
  for (const district of grouped.districts) {
    for (const id of district.itemIds) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  }
  expect(seen.size).toBe(items.length);
  for (const item of items) expect(grouped.byItemId.has(item.id)).toBe(true);
}

describe("every grouping", () => {
  it("puts every item in exactly one named district, and loses none", () => {
    for (const grouping of GROUPINGS) {
      everyItemPlacedOnce(shop, grouping);
      everyItemPlacedOnce(portfolio, grouping);
    }
  });

  it("names every district in Korean, with a line under it", () => {
    for (const grouping of GROUPINGS) {
      for (const district of groupItems(shop, shopLinks, grouping).districts) {
        expect(district.name.trim()).not.toBe("");
        // The renderer draws `${count}개 · ${folder}` and the screen-reader
        // mirror falls back to "이름 없는 곳" when this is empty, which for a
        // district called 조각 would be a lie about where the name came from.
        expect(district.folder.trim()).not.toBe("");
        expect(district.name).not.toMatch(/[A-Za-z]{4,}/);
      }
    }
  });

  it("gives the same answer whatever order the items arrive in", () => {
    for (const grouping of GROUPINGS) {
      const forwards = groupItems(shop, shopLinks, grouping);
      const backwards = groupItems([...shop].reverse(), [...shopLinks].reverse(), grouping);
      expect(backwards.districts).toEqual(forwards.districts);
    }
  });

  it("survives a project with nothing in it", () => {
    for (const grouping of GROUPINGS) {
      const grouped = groupItems([], [], grouping);
      expect(grouped.districts).toEqual([]);
      expect(grouped.byItemId.size).toBe(0);
    }
  });

  it("never reaches for the vocabulary the product hides", () => {
    // Section 1, and section 3's rule that we never call anything 안전.
    const banned = /노드|엣지|node|edge|entity|triple|ontology|안전/i;
    const said: string[] = [];
    for (const grouping of GROUPINGS) {
      said.push(GROUPING_WORDS[grouping].name, GROUPING_WORDS[grouping].meaning);
      for (const district of groupItems(shop, shopLinks, grouping).districts) {
        said.push(district.name, district.folder);
      }
    }
    for (const option of groupingOptions(portfolio, [])) {
      if (option.unavailable) said.push(option.unavailable);
    }
    for (const sentence of said) expect(sentence).not.toMatch(banned);
  });
});

describe("묶는 기준: 폴더", () => {
  it("is the same map it always was", () => {
    const grouped = groupItems(shop, shopLinks, "folder");
    const pieces = grouped.districts.find((district) => district.name === "화면 조각");
    expect(pieces?.itemIds).toEqual(["f-pay", "f-price", "s-pay", "s-price"]);
    expect(DEFAULT_GROUPING).toBe("folder");
  });
});

describe("묶는 기준: 종류", () => {
  it("names each district with the word the rest of the product uses", () => {
    const names = groupItems(shop, shopLinks, "kind").districts.map((d) => d.name);
    expect(names).toContain("파일");
    expect(names).toContain("조각");
    expect(names).toContain("페이지");
    expect(names).toContain("서버 주소");
    expect(names).toContain("외부 도구");
  });
});

describe("묶는 기준: 역할", () => {
  it("splits the pieces by what they do", () => {
    const grouped = groupItems(shop, shopLinks, "job");
    const byName = new Map(grouped.districts.map((d) => [d.name, d]));
    expect(byName.get("화면 조각")?.itemIds).toEqual(["s-checkout", "s-pay", "s-price"]);
    expect(byName.get("화면 도우미")?.itemIds).toEqual(["s-usecart"]);
    expect(byName.get("일 처리")?.itemIds).toEqual([
      "s-addtocart",
      "s-format",
      "s-postorder",
      "s-total",
    ]);
    expect(byName.get("정해 둔 모양")?.itemIds).toEqual(["s-money", "s-order"]);
  });

  it("puts what it cannot split somewhere named, and says it is that pile", () => {
    const grouped = groupItems(shop, shopLinks, "job");
    const other = grouped.districts.find((district) => district.residual);
    expect(other?.name).toBe("그 밖에");
    expect(other?.itemIds).toContain("f-logo");
    expect(other?.itemIds).toContain("pkg-react");
  });

  it("does not guess a role from a file extension", () => {
    // Every file on the portfolio would be easy to sort by suffix — .css is
    // surely 꾸미기 — and every one of those would be a guess presented as a
    // fact. They all land in the one pile that says so.
    const grouped = groupItems(portfolio, [], "job");
    expect(grouped.districts).toHaveLength(1);
    expect(grouped.districts[0].name).toBe("그 밖에");
  });
});

describe("묶는 기준: 쓰임새", () => {
  it("sorts by how many places use it, using the number the panel says", () => {
    const grouped = groupItems(shop, shopLinks, "usage");
    const byName = new Map(grouped.districts.map((d) => [d.name, d]));
    expect(byName.get("여러 곳에서 쓰는 것")?.itemIds).toEqual([
      "f-format",
      "pkg-react",
      "s-addtocart",
      "s-format",
      "s-order",
      "s-usecart",
    ]);
    expect(byName.get("한두 곳에서 쓰는 것")?.itemIds).toEqual([
      "s-money",
      "s-pay",
      "s-price",
      "s-total",
    ]);
    expect(byName.get("쓰는 곳을 못 찾은 것")?.itemIds).toContain("f-logo");
  });

  it("never turns “no connections we found” into a verdict", () => {
    const names = groupItems(shop, shopLinks, "usage").districts.map((d) => d.name);
    expect(names).toContain("쓰는 곳을 못 찾은 것");
    expect(names).not.toContain("안 쓰는 것");
  });
});

describe("묶는 기준: 기능", () => {
  const features: GraphItem[] = [
    ...shop,
    item({ id: "feat-pay", kind: "feature", name: "checkout", label: "결제" }),
    item({ id: "feat-cart", kind: "feature", name: "cart", label: "장바구니" }),
  ];
  const belongs: GraphConnection[] = [
    ...shopLinks,
    link("f-pay", "feat-pay", "belongs_to"),
    link("f-price", "feat-pay", "belongs_to"),
    link("f-cart", "feat-cart", "belongs_to"),
    link("f-format", "feat-pay", "belongs_to"),
  ];

  it("is offered as not-yet rather than as an empty map, while no names exist", () => {
    const option = groupingOptions(shop, shopLinks).find((o) => o.id === "feature");
    expect(option?.available).toBe(false);
    expect(option?.unavailable).toBe(
      "기능 이름은 아직 붙이기 전이에요. 이름이 붙으면 여기서 기능별로 볼 수 있어요.",
    );
  });

  it("turns itself on the moment a run writes the first feature, with no code change", () => {
    const option = groupingOptions(features, belongs).find((o) => o.id === "feature");
    expect(option?.available).toBe(true);
    expect(option?.districtCount).toBe(3);
  });

  it("reads the plain-language name and not the code one", () => {
    const names = groupItems(features, belongs, "feature").districts.map((d) => d.name);
    expect(names).toContain("결제");
    expect(names).toContain("장바구니");
    expect(names).not.toContain("checkout");
  });

  it("gives a piece its file's feature, so pieces are not all left over", () => {
    const grouped = groupItems(features, belongs, "feature");
    expect(grouped.byItemId.get("s-pay")?.name).toBe("결제");
    expect(grouped.byItemId.get("s-usecart")?.name).toBe("장바구니");
  });

  it("gives an item claimed by two features exactly one home, always the same one", () => {
    const contested = [...belongs, link("f-format", "feat-cart", "belongs_to")];
    const first = groupItems(features, contested, "feature");
    const second = groupItems(features, [...contested].reverse(), "feature");
    // 장바구니 holds more of the project once pieces have inherited their
    // file's feature, so the contested file goes there — and it goes there
    // whichever order the connections were read in, which is the part that
    // matters. A file that changed districts between two identical runs would
    // move under the hand of whoever was looking at it.
    expect(first.byItemId.get("f-format")?.name).toBe("장바구니");
    expect(second.byItemId.get("f-format")?.name).toBe("장바구니");
    expect(first.districts).toEqual(second.districts);
  });

  it("names the pile of what no feature claimed", () => {
    const grouped = groupItems(features, belongs, "feature");
    const left = grouped.districts.find((district) => district.residual);
    expect(left?.name).toBe("아직 묶지 않은 것");
    expect(left?.itemIds).toContain("pkg-react");
  });

  it("marks a feature someone fixed by hand as theirs", () => {
    const mine = [
      ...features.filter((f) => f.id !== "feat-pay"),
      item({ id: "feat-pay", kind: "feature", name: "checkout", label: "결제", fromUser: true }),
    ];
    const grouped = groupItems(mine, belongs, "feature");
    expect(grouped.byItemId.get("f-pay")?.folder).toBe("직접 붙인 이름");
  });
});

describe("a grouping that would draw one blob", () => {
  it("is not offered, and says why with the project's own numbers", () => {
    const option = groupingOptions(portfolio, []).find((o) => o.id === "kind");
    expect(option?.available).toBe(false);
    expect(option?.unavailable).toBe(
      "29개가 “파일” 하나에 몰려 있어서, 이렇게 묶으면 한 덩어리가 돼요.",
    );
  });

  it("is not offered when more than half of everything lands in the leftover pile", () => {
    const option = groupingOptions(portfolio, []).find((o) => o.id === "job");
    expect(option?.available).toBe(false);
    expect(option?.unavailable).toContain("한 덩어리");
  });

  it("still leaves 폴더 standing, because something has to be drawable", () => {
    const options = groupingOptions(portfolio, []);
    expect(options.find((o) => o.id === "folder")?.available).toBe(true);
    // And on a project that is one flat folder, 폴더 is still honest: that is
    // what the project looks like.
    const flat = [item({ id: "a", path: "a.js" }), item({ id: "b", path: "b.js" })];
    expect(groupingOptions(flat, []).find((o) => o.id === "folder")?.available).toBe(true);
  });

  it("offers the ones that do earn their place on a real repo", () => {
    const available = groupingOptions(shop, shopLinks)
      .filter((option) => option.available)
      .map((option) => option.id);
    expect(available).toEqual(["folder", "kind", "job", "usage"]);
  });

  it("counts the districts it would draw, so nobody commits blind", () => {
    const options = groupingOptions(shop, shopLinks);
    for (const option of options) {
      if (!option.available) continue;
      expect(option.districtCount).toBe(
        groupItems(shop, shopLinks, option.id).districts.length,
      );
    }
  });
});

describe("resolveGrouping", () => {
  it("falls back to 폴더 when what was chosen stopped being drawable", () => {
    const options = groupingOptions(portfolio, []);
    expect(resolveGrouping(options, "kind")).toBe("folder");
    expect(resolveGrouping(options, "usage")).toBe("usage");
    expect(resolveGrouping([], "job")).toBe("folder");
  });
});

describe("handing a grouping to the map", () => {
  it("lays the project out under any of them, losing nothing on the way", () => {
    for (const grouping of GROUPINGS) {
      const grouped = groupItems(shop, shopLinks, grouping);
      const layout = layoutMap(shop, districtLookup(grouped));

      expect(layout.items).toHaveLength(shop.length);
      expect(layout.districts).toHaveLength(grouped.districts.length);
      for (const placed of layout.items) {
        const district = layout.byDistrictId.get(placed.districtId);
        expect(district).toBeDefined();
        if (!district) continue;
        expect(
          Math.hypot(placed.x - district.x, placed.y - district.y) + placed.r,
        ).toBeLessThanOrEqual(district.r);
      }
    }
  });

  it("keeps every item on the map when the grouping changes under it", () => {
    // The continuity promise the control makes: switching rearranges the map,
    // it does not take anything off it. Same ids before and after, every time.
    const ids = (grouping: Grouping) => {
      const grouped = groupItems(shop, shopLinks, grouping);
      return [...layoutMap(shop, districtLookup(grouped)).byItemId.keys()].sort();
    };
    const folder = ids("folder");
    for (const grouping of GROUPINGS) expect(ids(grouping)).toEqual(folder);
  });

  it("puts the selected item somewhere findable under every grouping", () => {
    for (const grouping of GROUPINGS) {
      const grouped = groupItems(shop, shopLinks, grouping);
      const layout = layoutMap(shop, districtLookup(grouped));
      const selected = layout.byItemId.get("s-format");
      expect(selected).toBeDefined();
      expect(Number.isFinite(selected?.x)).toBe(true);
    }
  });
});
