import { describe, expect, it } from "vitest";

import type { GraphItem } from "@/lib/graph/view";

import { districtOf, layoutMap, DISTRICT_HUE_COUNT } from "./layout";

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

function files(...paths: string[]): GraphItem[] {
  return paths.map((path, index) => item({ id: `f${index}`, path, name: path }));
}

describe("districtOf", () => {
  it("reads a folder as a plain Korean name", () => {
    expect(districtOf(item({ id: "a", path: "src/components/PayButton.tsx" }))).toEqual({
      id: "place:pieces",
      name: "화면 조각",
      folder: "components/",
    });
    expect(districtOf(item({ id: "b", path: "src/lib/format.ts" })).name).toBe("공용 기능");
    expect(districtOf(item({ id: "c", path: "public/logo.png" })).name).toBe("이미지·파일");
  });

  it("treats src/ as a wrapper, not a place", () => {
    const wrapped = districtOf(item({ id: "a", path: "src/components/PayButton.tsx" }));
    const bare = districtOf(item({ id: "b", path: "components/PayButton.tsx" }));
    expect(wrapped.id).toBe(bare.id);
  });

  it("separates the server side from the screens it sits under", () => {
    expect(districtOf(item({ id: "a", path: "src/app/checkout/page.tsx" })).name).toBe("화면");
    expect(districtOf(item({ id: "b", path: "src/app/api/orders/route.ts" }))).toEqual({
      id: "place:endpoints",
      name: "서버 주소",
      folder: "app/api/",
    });
  });

  it("keeps the name the owner chose for a folder we do not recognise", () => {
    expect(districtOf(item({ id: "a", path: "wizardry/spell.ts" }))).toEqual({
      id: "dir:wizardry",
      name: "wizardry",
      folder: "wizardry/",
    });
  });

  it("puts files at the top of the project in one place", () => {
    expect(districtOf(item({ id: "a", path: "package.json" })).id).toBe("place:root");
    expect(districtOf(item({ id: "b", path: "src/index.ts" })).id).toBe("place:root");
  });

  it("gives packages a territory and never a path", () => {
    expect(districtOf(item({ id: "a", kind: "package", name: "react" }))).toEqual({
      id: "packages",
      name: "외부 도구",
      folder: "package.json",
    });
  });

  it("sends a symbol to the same territory as the file it came from", () => {
    const file = districtOf(item({ id: "a", path: "src/components/PayButton.tsx" }));
    const symbol = districtOf(
      item({
        id: "b",
        kind: "symbol",
        shape: "component",
        name: "PayButton",
        path: "src/components/PayButton.tsx",
      }),
    );
    expect(symbol).toEqual(file);
  });
});

describe("layoutMap", () => {
  const shop = files(
    "package.json",
    "tsconfig.json",
    "src/app/layout.tsx",
    "src/app/page.tsx",
    "src/app/checkout/page.tsx",
    "src/app/api/orders/route.ts",
    "src/components/PayButton.tsx",
    "src/components/PriceTag.tsx",
    "src/components/Badge.tsx",
    "src/components/Spinner.tsx",
    "src/components/admin/Badge.tsx",
    "src/lib/cart.ts",
    "src/lib/format.ts",
    "src/lib/orders.ts",
    "src/lib/useCart.ts",
    "src/legacy/totals.ts",
    "public/logo.png",
  ).concat([
    item({ id: "pkg-react", kind: "package", name: "react" }),
    item({ id: "pkg-next", kind: "package", name: "next" }),
  ]);

  it("gives the same picture for the same items, whatever order they arrive in", () => {
    const forwards = layoutMap(shop);
    const backwards = layoutMap([...shop].reverse());
    const shuffled = layoutMap([...shop].sort((a, b) => (a.id < b.id ? 1 : -1)));

    expect(backwards.districts).toEqual(forwards.districts);
    expect(backwards.items).toEqual(forwards.items);
    expect(shuffled.districts).toEqual(forwards.districts);
    expect(shuffled.items).toEqual(forwards.items);
  });

  it("never lets two districts touch", () => {
    // Deliberately lopsided: one enormous folder, a crowd of small ones. Even
    // packing is easy; this is the shape that breaks a naive grid.
    const many = files(
      ...Array.from({ length: 120 }, (_, i) => `src/components/C${i}.tsx`),
      ...Array.from({ length: 30 }, (_, i) => `src/lib/l${i}.ts`),
      ...Array.from({ length: 24 }, (_, i) => `folder${i}/only.ts`),
      "package.json",
    );
    const layout = layoutMap(many);
    expect(layout.districts.length).toBeGreaterThan(20);

    for (let i = 0; i < layout.districts.length; i++) {
      for (let j = i + 1; j < layout.districts.length; j++) {
        const a = layout.districts[i];
        const b = layout.districts[j];
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r);
        expect(gap).toBeGreaterThan(0);
      }
    }
  });

  /**
   * Colour is the only thing telling two territories apart once the map is
   * zoomed out far enough that the names have gone, so two neighbours wearing
   * the same one is two places reading as one. The old rule — the size rank
   * modulo six — broke on the seventh territory, which the packing puts in the
   * ring where the first one's neighbours already are.
   */
  it("never puts the same colour on a territory's nearest neighbour", () => {
    const many = files(
      ...Array.from({ length: 40 }, (_, i) => `src/components/C${i}.tsx`),
      ...Array.from({ length: 20 }, (_, i) => `src/lib/l${i}.ts`),
      ...Array.from({ length: 18 }, (_, i) => `folder${i}/only.ts`),
      "package.json",
    );
    const layout = layoutMap(many);
    expect(layout.districts.length).toBeGreaterThan(DISTRICT_HUE_COUNT);

    for (const district of layout.districts) {
      let nearest = null;
      let best = Infinity;
      for (const other of layout.districts) {
        if (other.id === district.id) continue;
        const gap = Math.hypot(other.x - district.x, other.y - district.y) - other.r;
        if (gap < best) {
          best = gap;
          nearest = other;
        }
      }
      expect(nearest).not.toBeNull();
      expect(nearest?.hue).not.toBe(district.hue);
    }
  });

  it("spends all six colours before it reuses one", () => {
    const layout = layoutMap(shop);
    const used = layout.districts.slice(0, DISTRICT_HUE_COUNT).map((d) => d.hue);
    expect(new Set(used).size).toBe(used.length);
  });

  it("keeps every item inside its own district", () => {
    const layout = layoutMap(shop);
    for (const placed of layout.items) {
      const district = layout.byDistrictId.get(placed.districtId);
      expect(district).toBeDefined();
      if (!district) continue;
      const distance = Math.hypot(placed.x - district.x, placed.y - district.y);
      expect(distance + placed.r).toBeLessThanOrEqual(district.r);
    }
  });

  it("finds somewhere for an item with no path at all", () => {
    const layout = layoutMap([
      item({ id: "orphan", kind: "symbol", name: "somethingWeFound" }),
      ...files("src/app/page.tsx"),
    ]);
    const placed = layout.byItemId.get("orphan");
    expect(placed).toBeDefined();
    expect(Number.isFinite(placed?.x)).toBe(true);
    expect(Number.isFinite(placed?.y)).toBe(true);
    expect(placed?.districtId).toBe("elsewhere");
  });

  it("merges folders that are the same place, and says which ones", () => {
    // Measured on a portfolio site: `images/` and `assets/fonts/` produced two
    // territories side by side, both called 이미지·파일, which is unreadable.
    const layout = layoutMap(
      files("images/a.jpg", "assets/fonts/b.woff2", "public/c.png", "src/app/page.tsx"),
    );
    const assets = layout.districts.find((d) => d.name === "이미지·파일");
    expect(assets).toBeDefined();
    expect(assets?.count).toBe(3);
    expect(assets?.folder).toBe("assets/, images/ 외 1곳");
    expect(layout.districts.filter((d) => d.name === "이미지·파일")).toHaveLength(1);
  });

  it("draws a map of a site that has no symbols in it at all", () => {
    // The founder's own portfolio: every item a file, nothing else. A design
    // that only works once components exist is not a design.
    const portfolio = files(
      "index.html",
      "about.html",
      "contact.html",
      ...Array.from({ length: 20 }, (_, i) => `assets/photo${i}.jpg`),
      ...Array.from({ length: 6 }, (_, i) => `css/part${i}.css`),
      ...Array.from({ length: 5 }, (_, i) => `js/part${i}.js`),
    );
    const layout = layoutMap(portfolio);

    expect(layout.items).toHaveLength(portfolio.length);
    expect(layout.districts.map((d) => d.name).sort()).toEqual(
      ["스타일", "이미지·파일", "js", "맨 위"].sort(),
    );
    expect(layout.bounds.maxX - layout.bounds.minX).toBeGreaterThan(0);
    expect(layout.bounds.maxY - layout.bounds.minY).toBeGreaterThan(0);
  });

  it("holds the whole map inside the bounds it reports", () => {
    const layout = layoutMap(shop);
    for (const district of layout.districts) {
      expect(district.x - district.r).toBeGreaterThanOrEqual(layout.bounds.minX);
      expect(district.x + district.r).toBeLessThanOrEqual(layout.bounds.maxX);
      expect(district.y - district.r).toBeGreaterThanOrEqual(layout.bounds.minY);
      expect(district.y + district.r).toBeLessThanOrEqual(layout.bounds.maxY);
    }
  });

  it("draws a more connected item larger than a lonely one", () => {
    const layout = layoutMap([
      item({ id: "hub", path: "src/lib/format.ts", usedBy: 30, uses: 4 }),
      item({ id: "leaf", path: "src/lib/lonely.ts" }),
    ]);
    const hub = layout.byItemId.get("hub");
    const leaf = layout.byItemId.get("leaf");
    expect(hub && leaf && hub.r > leaf.r).toBe(true);
  });

  it("packs the territories it is handed, not only the folders", () => {
    // The folder reading is the default and not the only answer; `grouping.ts`
    // supplies the others. Everything below the assignment is indifferent to
    // which one named the places.
    const layout = layoutMap(shop, (item) =>
      item.kind === "package"
        ? { id: "outside", name: "밖에서 가져온 것", folder: "package.json" }
        : { id: "inside", name: "내가 만든 것", folder: "내 프로젝트" },
    );

    expect(layout.districts.map((d) => d.name)).toEqual(["내가 만든 것", "밖에서 가져온 것"]);
    expect(layout.items).toHaveLength(shop.length);
    for (const placed of layout.items) {
      const district = layout.byDistrictId.get(placed.districtId);
      expect(district).toBeDefined();
      if (!district) continue;
      const distance = Math.hypot(placed.x - district.x, placed.y - district.y);
      expect(distance + placed.r).toBeLessThanOrEqual(district.r);
    }
  });

  it("survives an empty project without throwing", () => {
    const layout = layoutMap([]);
    expect(layout.districts).toEqual([]);
    expect(layout.items).toEqual([]);
    expect(layout.bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});
