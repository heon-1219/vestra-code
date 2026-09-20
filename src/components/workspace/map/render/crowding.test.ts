import { writeFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { IDLE_BEAM } from "../beam";
import { districtLookup, groupItems } from "../grouping";
import { layoutMap, type MapLayout } from "../layout";
import { syntheticProject, PRODUCTION_ITEM_COUNT } from "../scale-fixture";

import {
  detailAt,
  thresholdsFor,
  viewFraction,
  LINK_BUDGET,
  MAX_SCALE,
  MIN_SCALE,
  NAME_BUDGET,
  RELATION_BUDGET,
} from "./lod";
import {
  displayNameOf,
  drawMap,
  heldBackSentence,
  type Camera,
  type Road,
  type Scene,
  type View,
} from "./paint";
import { FALLBACK } from "./palette";
import {
  asContext,
  crowdingOf,
  drawnCircles,
  measureTextWidth,
  Probe,
  VIEWPORTS,
  type Crowding,
} from "./probe";
import {
  buildLinks,
  colourCarriesGrouping,
  hubsOf,
  nameRanks,
  NO_FOCUS,
  NO_TRAIL,
} from "./scene";

/**
 * What the map does at the size it is actually used at.
 *
 * Every threshold in `lod.ts` was set against a 68-item demo or a 300-item
 * fixture. The project in production holds **1,442**. This file builds one of
 * those and counts, so that "겹침 x" is a number rather than an impression.
 *
 * Read the numbers with `VESTRA_MAP_REPORT=1 npx vitest run
 * src/components/workspace/map/render/crowding.test.ts` — the same run prints
 * the table the assertions are drawn from, which is how the next person
 * re-measures after changing a budget.
 */

const PROJECT = syntheticProject();
const GROUPED = groupItems(PROJECT.items, PROJECT.connections, "folder");
const LAYOUT = layoutMap(PROJECT.items, districtLookup(GROUPED));
const LINKS = buildLinks(PROJECT.items, PROJECT.connections, LAYOUT);
const HUBS = hubsOf(LAYOUT, PROJECT.items);
const NAME_RANK = nameRanks(LAYOUT, PROJECT.items);

/**
 * The middle name's width in this project, at 11px.
 *
 * The same sample and the same order the painter measures, so the numbers the
 * report prints are the numbers the renderer acted on. It is here as a constant
 * only because `thresholdsFor` is called directly in two of the tests below;
 * the painter measures it itself.
 */
const MEASURED_NAME_WIDTH = (() => {
  const widths = PROJECT.items
    .filter((one) => (NAME_RANK.get(one.id) ?? Infinity) < 64)
    .sort((a, b) => (NAME_RANK.get(a.id) ?? 0) - (NAME_RANK.get(b.id) ?? 0))
    .map((one) => measureTextWidth(displayNameOf(one), 11))
    .sort((a, b) => a - b);
  return widths[widths.length >> 1];
})();
const ITEMS_BY_ID = new Map(PROJECT.items.map((one) => [one.id, one]));

const ROADS: Road[] = (() => {
  const tally = new Map<string, Road>();
  for (const connection of PROJECT.connections) {
    const from = LAYOUT.byItemId.get(connection.from);
    const to = LAYOUT.byItemId.get(connection.to);
    if (!from || !to || from.districtId === to.districtId) continue;
    const a = LAYOUT.byDistrictId.get(from.districtId);
    const b = LAYOUT.byDistrictId.get(to.districtId);
    if (!a || !b) continue;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const existing = tally.get(key) ?? {
      a: a.id < b.id ? a : b,
      b: a.id < b.id ? b : a,
      certain: 0,
      inferred: 0,
    };
    if (connection.certainty === "certain") existing.certain++;
    else existing.inferred++;
    tally.set(key, existing);
  }
  return [...tally.values()];
})();

const FIT_PADDING = 56;

function fitScaleFor(layout: MapLayout, width: number, height: number): number {
  const worldWidth = Math.max(layout.bounds.maxX - layout.bounds.minX, 1);
  const worldHeight = Math.max(layout.bounds.maxY - layout.bounds.minY, 1);
  return Math.min(
    MAX_SCALE,
    Math.max(
      MIN_SCALE,
      Math.min(
        (width - FIT_PADDING * 2) / worldWidth,
        (height - FIT_PADDING * 2) / worldHeight,
      ),
    ),
  );
}

function sceneWith(over: Partial<Scene> = {}): Scene {
  return {
    layout: LAYOUT,
    roads: ROADS,
    links: LINKS,
    itemsById: ITEMS_BY_ID,
    hubs: HUBS,
    nameRank: NAME_RANK,
    grouped: colourCarriesGrouping(
      {
        id: "folder",
        name: "폴더",
        meaning: "",
        available: true,
        unavailable: null,
        districtCount: LAYOUT.districts.length,
      },
      LAYOUT.districts.length,
    ),
    beam: IDLE_BEAM,
    selection: NO_FOCUS,
    pointed: NO_FOCUS,
    selectedId: null,
    trail: NO_TRAIL,
    size: null,
    ...over,
  };
}

/** The busiest territory, which is where the map is hardest to read. */
function densestDistrict() {
  return [...LAYOUT.districts].sort((a, b) => b.count - a.count)[0];
}

type Probed = { crowding: Crowding; probe: Probe };

function probeFrame(
  width: number,
  height: number,
  camera: Camera,
  scene: Scene = sceneWith({ size: { width, height } }),
): Probed {
  const probe = new Probe();
  const view: View = {
    width,
    height,
    dpr: 1,
    camera,
    palette: FALLBACK,
    font: "sans-serif",
    fitScale: fitScaleFor(scene.layout, width, height),
  };
  drawMap(asContext(probe), scene, view);
  const circles = drawnCircles(scene.layout, scene.hubs, camera, width, height);
  return { crowding: crowdingOf(probe, circles, width, height), probe };
}

/**
 * The zooms worth counting at.
 *
 * Not round numbers: each one is a place the picture changes its mind. The
 * resting fit is what someone sees first; the link threshold is where strings
 * appear; the name threshold is where words appear; and the ceiling is where
 * someone who kept turning the wheel ends up.
 */
function zoomsFor(width: number, height: number) {
  const fit = fitScaleFor(LAYOUT, width, height);
  const thresholds = thresholdsFor({
    linkCount: LINKS.length,
    itemCount: LAYOUT.items.length,
    itemArea: LAYOUT.itemArea,
    viewWidth: width,
    viewHeight: height,
    fitScale: fit,
    names: { median: MEASURED_NAME_WIDTH },
  });
  return [
    { name: "resting fit", scale: fit },
    { name: "links on", scale: thresholds.linkScale * 1.15 },
    { name: "names on", scale: Math.min(MAX_SCALE, thresholds.nameScale * 1.15) },
    { name: "ceiling", scale: MAX_SCALE },
  ];
}

const REPORT = process.env.VESTRA_MAP_REPORT;

const lines: string[] = [];

/**
 * The table goes to a file rather than to the console.
 *
 * A test runner is free to buffer, interleave or swallow `console.log`, and a
 * measurement you cannot reliably read is not one. Set `VESTRA_MAP_REPORT` to a
 * path and the numbers land there.
 */
function report(line: string): void {
  if (REPORT) lines.push(line);
}

afterAll(() => {
  if (REPORT) writeFileSync(REPORT, lines.join(String.fromCharCode(10)), "utf8");
});

/** Every frame worth counting: three viewports, four zooms, two places to stand. */
function sweep(): { key: string; crowding: Crowding }[] {
  const out: { key: string; crowding: Crowding }[] = [];
  const dense = densestDistrict();
  for (const viewport of VIEWPORTS) {
    for (const zoom of zoomsFor(viewport.width, viewport.height)) {
      const middle: Camera = {
        x: (LAYOUT.bounds.minX + LAYOUT.bounds.maxX) / 2,
        y: (LAYOUT.bounds.minY + LAYOUT.bounds.maxY) / 2,
        scale: zoom.scale,
      };
      const inside: Camera = { x: dense.x, y: dense.y, scale: zoom.scale };
      out.push({
        key: `${viewport.name} · ${zoom.name} · 가운데`,
        crowding: probeFrame(viewport.width, viewport.height, middle).crowding,
      });
      out.push({
        key: `${viewport.name} · ${zoom.name} · ${dense.name} 안`,
        crowding: probeFrame(viewport.width, viewport.height, inside).crowding,
      });
    }
  }
  return out;
}

describe("the map at the size production actually holds", () => {
  it("is the project it says it is", () => {
    expect(PROJECT.items).toHaveLength(PRODUCTION_ITEM_COUNT);
    report(
      `\n  ${PROJECT.items.length} items, ${PROJECT.connections.length} connections, ` +
        `${LAYOUT.districts.length} districts, ${LINKS.length} drawable links`,
    );
    report(
      `  largest district: ${densestDistrict().name} — ${densestDistrict().count} items\n`,
    );
  });

  it("counts every kind of collision at every scale worth reading it at", () => {
    const rows = sweep();
    report(
      "  " +
        "frame".padEnd(34) +
        [
          "label×label",
          "label×item",
          "item×item",
          "link×link",
          "under name",
          "under word",
          "names",
          "relations",
          "items",
          "links",
          "words drawn",
        ]
          .map((one) => one.padStart(12))
          .join(""),
    );
    for (const row of rows) {
      const c = row.crowding;
      report(
        "  " +
          row.key.padEnd(34) +
          [
            c.labelLabel,
            c.labelItem,
            c.itemItem,
            c.linkCrossings,
            c.linksUnderNames,
            c.linksUnderRelations,
            c.names,
            c.relations,
            c.items,
            c.links,
            c.drawnWords,
          ]
            .map((one) => String(one).padStart(12))
            .join(""),
      );
    }
    expect(rows.length).toBeGreaterThan(0);

    /*
     * The founder's "겹침 x", as three numbers that have to stay at zero.
     *
     * Before this wave, on this same graph: up to **513 pairs of words lying on
     * each other**, **228 words lying on a dot**, and **7 pairs of overlapping
     * dots** — the last of them at the resting zoom, on the screen this product
     * opens with.
     */
    for (const row of rows) {
      expect({ frame: row.key, pairs: row.crowding.labelLabel }).toEqual({
        frame: row.key,
        pairs: 0,
      });
      expect({ frame: row.key, on: row.crowding.labelItem }).toEqual({
        frame: row.key,
        on: 0,
      });
      expect({ frame: row.key, dots: row.crowding.itemItem }).toEqual({
        frame: row.key,
        dots: 0,
      });
    }
  });

  /**
   * The budgets, checked against what actually reached the canvas.
   *
   * `lod.test.ts` proves the ceilings spend the budget under the density model;
   * this proves the model is not lying, which is the part that was wrong. The
   * bound is generous — clustering is real and the model is an average — but it
   * is an order of magnitude tighter than what was measured before: 786
   * relation words against a budget of 28, and 139 names against 36.
   */
  it("keeps what it says on screen near what it budgeted for", () => {
    for (const row of sweep()) {
      expect({ frame: row.key, over: row.crowding.relations > RELATION_BUDGET * 2 }).toEqual({
        frame: row.key,
        over: false,
      });
      expect({ frame: row.key, over: row.crowding.names > NAME_BUDGET * 2 }).toEqual({
        frame: row.key,
        over: false,
      });
      expect({ frame: row.key, over: row.crowding.links > LINK_BUDGET * 3 }).toEqual({
        frame: row.key,
        over: false,
      });
    }
  });

  /**
   * Determinism, asserted about the ink rather than about the layout.
   *
   * `layout.ts`, `grouping.ts` and `buildLinks` each promise that the same
   * project draws the same picture, and each has its own test. None of them
   * covered the part added in this wave: a label field is a *stateful* thing
   * that hands out places in the order it is asked, so it could have made the
   * picture depend on iteration order, on a `Set`, or on `Map` insertion. Two
   * frames of the same scene have to be identical word for word and stroke for
   * stroke.
   */
  it("draws the identical frame twice for an unchanged project", () => {
    const camera: Camera = {
      x: (LAYOUT.bounds.minX + LAYOUT.bounds.maxX) / 2,
      y: (LAYOUT.bounds.minY + LAYOUT.bounds.maxY) / 2,
      scale: MAX_SCALE * 0.75,
    };
    const once = probeFrame(1400, 900, camera).probe;
    const twice = probeFrame(1400, 900, camera).probe;
    expect(twice.texts).toEqual(once.texts);
    expect(twice.lines).toEqual(once.lines);
    expect(twice.fills).toBe(once.fills);
    expect(twice.strokes).toBe(once.strokes);
    expect(once.texts.length).toBeGreaterThan(0);
  });

  /**
   * And identical again when the same project arrives in a different order.
   *
   * The layout already promises this. What is new is that the label field must
   * not turn a re-ordered arrival into a different set of drawn words, which it
   * would if any rank anywhere fell back on arrival order to break a tie.
   */
  it("draws the identical frame for the same project shuffled", () => {
    const shuffled = [...PROJECT.items].reverse();
    const layout = layoutMap(
      shuffled,
      districtLookup(groupItems(shuffled, PROJECT.connections, "folder")),
    );
    const links = buildLinks(shuffled, PROJECT.connections, layout);
    const scene = sceneWith({
      layout,
      links,
      hubs: hubsOf(layout, shuffled),
      nameRank: nameRanks(layout, shuffled),
      itemsById: new Map(shuffled.map((one) => [one.id, one])),
      size: { width: 1400, height: 900 },
    });
    const camera: Camera = {
      x: (LAYOUT.bounds.minX + LAYOUT.bounds.maxX) / 2,
      y: (LAYOUT.bounds.minY + LAYOUT.bounds.maxY) / 2,
      scale: MAX_SCALE * 0.75,
    };
    const straight = probeFrame(1400, 900, camera).probe;
    const reversed = probeFrame(1400, 900, camera, scene).probe;
    expect(reversed.texts).toEqual(straight.texts);
  });

  /**
   * Nothing is dropped in silence.
   *
   * The link budget and the label field both decline to draw things on purpose.
   * That is right, and it is only right because the map says so — the same
   * promise `neighbourhood.ts` keeps with "N개는 줄였어요". This checks the
   * sentence exists whenever the count does, and that it is 해요체 and free of
   * the vocabulary `view.ts` keeps off this side of the boundary.
   */
  it("says how much it held back, in the product's own register", () => {
    let sawSomething = false;
    for (const viewport of VIEWPORTS) {
      for (const zoom of zoomsFor(viewport.width, viewport.height)) {
        const probe = new Probe();
        const scene = sceneWith({ size: { width: viewport.width, height: viewport.height } });
        const report = drawMap(asContext(probe), scene, {
          width: viewport.width,
          height: viewport.height,
          dpr: 1,
          camera: {
            x: densestDistrict().x,
            y: densestDistrict().y,
            scale: zoom.scale,
          },
          palette: FALLBACK,
          font: "sans-serif",
          fitScale: fitScaleFor(LAYOUT, viewport.width, viewport.height),
        });
        const sentence = heldBackSentence(report);
        if (report.linksHeld === 0 && report.labelsHeld === 0) {
          expect(sentence).toBe("");
          continue;
        }
        sawSomething = true;
        expect(sentence).toContain("줄였어요");
        expect(sentence).toContain("더 크게 보면");
        if (report.linksHeld > 0) {
          expect(sentence).toContain(report.linksHeld.toLocaleString("ko-KR"));
        }
        if (report.labelsHeld > 0) {
          expect(sentence).toContain(report.labelsHeld.toLocaleString("ko-KR"));
        }
        for (const word of ["노드", "엣지", "안전", "링크", "라벨"]) {
          expect(sentence).not.toContain(word);
        }
      }
    }
    // A map this size always holds something back somewhere, and if it ever
    // stopped doing so the sentence would be dead code nobody noticed.
    expect(sawSomething).toBe(true);
  });
});

/**
 * A walk across a project this size still reads as a path.
 *
 * The exemptions in `prepareThreads` and `placeWalkNumbers` are written for
 * exactly this case and none of the small fixtures can test it: at 1,442 items
 * the link budget holds back more than a thousand lines and the label field
 * refuses most of the words it is offered, and a walk has to come through both
 * of those intact. A walk with step 2 missing is not a smaller picture, it is a
 * wrong one.
 */
describe("a walk across a project of this size", () => {
  const HOPS = (() => {
    // Six real connections, taken in the order `buildLinks` ranks them so the
    // walk is a plausible one rather than a set of ids that happen to exist.
    const steps = [];
    for (const link of LINKS) {
      if (steps.length >= 6) break;
      if (link.relation === "contains") continue;
      steps.push({
        order: steps.length + 1,
        fromId: link.from,
        toId: link.to,
        critical: steps.length % 2 === 0,
        connected: true,
      });
    }
    return steps;
  })();

  const TRAIL = {
    steps: HOPS,
    lit: new Set(HOPS.flatMap((one) => [one.fromId, one.toId])),
    critical: new Set<string>(),
  };

  it("numbers every hop, at the zoom where the whole map fits", () => {
    for (const viewport of VIEWPORTS) {
      const probe = new Probe();
      const scale = fitScaleFor(LAYOUT, viewport.width, viewport.height);
      drawMap(
        asContext(probe),
        sceneWith({
          trail: TRAIL,
          size: { width: viewport.width, height: viewport.height },
        }),
        {
          width: viewport.width,
          height: viewport.height,
          dpr: 1,
          camera: {
            x: (LAYOUT.bounds.minX + LAYOUT.bounds.maxX) / 2,
            y: (LAYOUT.bounds.minY + LAYOUT.bounds.maxY) / 2,
            scale,
          },
          palette: FALLBACK,
          font: "sans-serif",
          fitScale: scale,
        },
      );
      const numbers = probe.texts
        .filter((one) => one.kind === "relation")
        .map((one) => Number.parseInt(one.text, 10))
        .filter((one) => Number.isFinite(one))
        .sort((a, b) => a - b);
      // Every hop whose line is long enough to hold a number carries one, and
      // nothing on the map is numbered that is not a hop.
      expect({ view: viewport.name, numbers }).toEqual({
        view: viewport.name,
        numbers: HOPS.map((one) => one.order),
      });
    }
  });

  it("writes on no line but the walk's, whatever the budget would otherwise say", () => {
    const probe = new Probe();
    const scale = fitScaleFor(LAYOUT, 1400, 900) * 4;
    drawMap(
      asContext(probe),
      sceneWith({ trail: TRAIL, size: { width: 1400, height: 900 } }),
      {
        width: 1400,
        height: 900,
        dpr: 1,
        camera: {
          x: (LAYOUT.bounds.minX + LAYOUT.bounds.maxX) / 2,
          y: (LAYOUT.bounds.minY + LAYOUT.bounds.maxY) / 2,
          scale,
        },
        palette: FALLBACK,
        font: "sans-serif",
        fitScale: fitScaleFor(LAYOUT, 1400, 900),
      },
    );
    for (const word of probe.texts.filter((one) => one.kind === "relation")) {
      expect(word.text).toMatch(/^\d+( · .+)?$/);
    }
  });
});

/**
 * The demo, which is what the founder and everyone else actually looks at.
 *
 * Every number in `lod.ts` was originally set against a 68-item graph, and this
 * wave moved all of them. A fix for 1,442 items that quietly made the demo
 * worse would be a bad trade, so the small case is measured too — with the same
 * instrument, in the same run.
 */
describe("a demo-sized project, after all of this", () => {
  const DEMO = syntheticProject(68, 0x64_65_6d_6f);
  const DEMO_LAYOUT = layoutMap(
    DEMO.items,
    districtLookup(groupItems(DEMO.items, DEMO.connections, "folder")),
  );
  const DEMO_LINKS = buildLinks(DEMO.items, DEMO.connections, DEMO_LAYOUT);

  it("still brings the words on within a notch of the lines", () => {
    const fit = fitScaleFor(DEMO_LAYOUT, 1400, 900);
    const thresholds = thresholdsFor({
      linkCount: DEMO_LINKS.length,
      itemCount: DEMO_LAYOUT.items.length,
      itemArea: DEMO_LAYOUT.itemArea,
      viewWidth: 1400,
      viewHeight: 900,
      fitScale: fit,
      names: { median: MEASURED_NAME_WIDTH },
    });
    report(
      `  demo (${DEMO.items.length} items, ${DEMO_LINKS.length} links): fit ${fit.toFixed(2)} · ` +
        `linkScale ${thresholds.linkScale.toFixed(2)} · relationScale ` +
        `${thresholds.relationScale.toFixed(2)} · nameScale ${thresholds.nameScale.toFixed(2)}`,
    );
    // Words may never arrive before the lines they sit on, and on a graph this
    // small they must not be pushed to the far end of the wheel either.
    expect(thresholds.relationScale).toBeGreaterThanOrEqual(thresholds.linkScale);
    expect(thresholds.relationScale).toBeLessThanOrEqual(MAX_SCALE * 0.75);
  });

  it("keeps every line and every word it can, because there is room for them", () => {
    const fit = fitScaleFor(DEMO_LAYOUT, 1400, 900);
    const probe = new Probe();
    const scene: Scene = {
      ...sceneWith({ size: { width: 1400, height: 900 } }),
      layout: DEMO_LAYOUT,
      links: DEMO_LINKS,
      roads: [],
      hubs: hubsOf(DEMO_LAYOUT, DEMO.items),
      nameRank: nameRanks(DEMO_LAYOUT, DEMO.items),
      itemsById: new Map(DEMO.items.map((one) => [one.id, one])),
    };
    const report_ = drawMap(asContext(probe), scene, {
      width: 1400,
      height: 900,
      dpr: 1,
      camera: {
        x: (DEMO_LAYOUT.bounds.minX + DEMO_LAYOUT.bounds.maxX) / 2,
        y: (DEMO_LAYOUT.bounds.minY + DEMO_LAYOUT.bounds.maxY) / 2,
        scale: fit * 2.6,
      },
      palette: FALLBACK,
      font: "sans-serif",
      fitScale: fit,
    });
    const crowding = crowdingOf(
      probe,
      drawnCircles(
        DEMO_LAYOUT,
        scene.hubs,
        {
          x: (DEMO_LAYOUT.bounds.minX + DEMO_LAYOUT.bounds.maxX) / 2,
          y: (DEMO_LAYOUT.bounds.minY + DEMO_LAYOUT.bounds.maxY) / 2,
          scale: fit * 2.6,
        },
        1400,
        900,
      ),
      1400,
      900,
    );
    report(
      `  demo at 2.6x fit: ${report_.linksDrawn} lines drawn, ${report_.linksHeld} held · ` +
        `${report_.labelsDrawn} words drawn, ${report_.labelsHeld} held · ` +
        `${crowding.labelLabel} label overlaps`,
    );
    /*
     * Nothing on a graph this size is held back for being too crowded: the
     * ceiling at this zoom is above the whole link count. What is held back is
     * the handful of lines whose two ends are both off the edge, which is the
     * geometric rule and not the budget — and the map says so either way.
     */
    expect(report_.linksHeld).toBeLessThan(DEMO_LINKS.length * 0.1);
    expect(report_.linksDrawn).toBeGreaterThan(DEMO_LINKS.length * 0.7);
    expect(crowding.labelLabel).toBe(0);
    expect(crowding.itemItem).toBe(0);
  });
});

describe("the packing, and the budgets, in their own terms", () => {
  it("reports how close two packed items come to each other", () => {
    const byDistrict = new Map<string, typeof LAYOUT.items>();
    for (const placed of LAYOUT.items) {
      const list = byDistrict.get(placed.districtId);
      if (list) list.push(placed);
      else byDistrict.set(placed.districtId, [placed]);
    }
    let touching = 0;
    let worstRatio = 0;
    let minPitch = Infinity;
    for (const list of byDistrict.values()) {
      for (let i = 0; i < list.length; i++) {
        let nearest = Infinity;
        for (let j = 0; j < list.length; j++) {
          if (i === j) continue;
          const d = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y);
          if (d < nearest) nearest = d;
          if (d < list[i].r + list[j].r) {
            if (j > i) touching++;
            worstRatio = Math.max(worstRatio, (list[i].r + list[j].r) / Math.max(d, 1e-9));
          }
        }
        if (nearest < minPitch) minPitch = nearest;
      }
    }
    // Which of the screen-space overlaps are the hub boost rather than the
    // packing: the same frame, drawn once with hubs and once without.
    for (const viewport of VIEWPORTS) {
      const scale = fitScaleFor(LAYOUT, viewport.width, viewport.height);
      const camera: Camera = {
        x: (LAYOUT.bounds.minX + LAYOUT.bounds.maxX) / 2,
        y: (LAYOUT.bounds.minY + LAYOUT.bounds.maxY) / 2,
        scale,
      };
      const count = (hubs: ReadonlyMap<string, string>) => {
        const circles = drawnCircles(LAYOUT, hubs, camera, viewport.width, viewport.height);
        let pairs = 0;
        for (let i = 0; i < circles.length; i++) {
          for (let j = i + 1; j < circles.length; j++) {
            if (
              Math.hypot(circles[i].x - circles[j].x, circles[i].y - circles[j].y) <
              circles[i].r + circles[j].r
            ) {
              pairs++;
            }
          }
        }
        return pairs;
      };
      report(
        `  ${viewport.name} at rest: ${count(HUBS)} overlapping dots with hubs, ` +
          `${count(new Map())} without`,
      );
    }
    report(`  packing: ${touching} overlapping pairs in world space, tightest pitch ${minPitch.toFixed(2)}, worst (r+r)/d ${worstRatio.toFixed(2)}`);
    report(`  map bounds ${(LAYOUT.bounds.maxX - LAYOUT.bounds.minX).toFixed(0)} x ${(LAYOUT.bounds.maxY - LAYOUT.bounds.minY).toFixed(0)}`);
    expect(minPitch).toBeGreaterThan(0);
  });

  it("reports what the level-of-detail rules actually decide at this size", () => {
    for (const viewport of VIEWPORTS) {
      const fit = fitScaleFor(LAYOUT, viewport.width, viewport.height);
      const thresholds = thresholdsFor({
        linkCount: LINKS.length,
        itemCount: LAYOUT.items.length,
        itemArea: LAYOUT.itemArea,
        viewWidth: viewport.width,
        viewHeight: viewport.height,
        fitScale: fit,
        names: { median: MEASURED_NAME_WIDTH },
      });
      const at = (scale: number) => detailAt(thresholds, scale);
      report(
        `  ${viewport.name}: fit ${fit.toFixed(3)} · linkScale ${thresholds.linkScale.toFixed(2)} · ` +
          `relationScale ${thresholds.relationScale.toFixed(2)} · nameScale ${thresholds.nameScale.toFixed(2)} · ` +
          `ceiling ${MAX_SCALE}`,
      );
      for (const scale of [fit, thresholds.nameScale * 1.15, MAX_SCALE]) {
        const detail = at(Math.min(scale, MAX_SCALE));
        const fraction = viewFraction(thresholds, Math.min(scale, MAX_SCALE));
        report(
          `    at ${Math.min(scale, MAX_SCALE).toFixed(2)}: viewFraction ${fraction.toFixed(4)} · ` +
            `expected links on screen ${(LINKS.length * fraction).toFixed(0)} · ` +
            `expected names ${(LAYOUT.items.length * fraction).toFixed(0)} · ` +
            `link ceiling ${detail.linkCeiling.toFixed(0)} · relation ceiling ` +
            `${detail.relationCeiling.toFixed(0)} · name ceiling ${detail.nameCeiling.toFixed(0)} ` +
            `(of ${LINKS.length} links, ${LAYOUT.items.length} items)`,
        );
      }
    }
    expect(VIEWPORTS.length).toBeGreaterThan(0);
  });

  it("reports what one frame costs at this size", () => {
    const camera: Camera = {
      x: (LAYOUT.bounds.minX + LAYOUT.bounds.maxX) / 2,
      y: (LAYOUT.bounds.minY + LAYOUT.bounds.maxY) / 2,
      scale: fitScaleFor(LAYOUT, 1400, 900),
    };
    for (const where of [
      { name: "resting fit", camera },
      { name: "zoomed in", camera: { ...camera, scale: MAX_SCALE * 0.75 } },
    ]) {
      const probe = new Probe();
      const scene = sceneWith({ size: { width: 1400, height: 900 } });
      const view: View = {
        width: 1400,
        height: 900,
        dpr: 1,
        camera: where.camera,
        palette: FALLBACK,
        font: "sans-serif",
        fitScale: fitScaleFor(LAYOUT, 1400, 900),
      };
      /*
       * Reported as work done, and as the best of several passes.
       *
       * Four other agents are building on this machine, so a wall-clock number
       * from one run is a measurement of the load average. The work counts —
       * fills, strokes, arcs and above all **words**, each of which is a text
       * layout and a shadowed fill on a real canvas — are what actually
       * changed, and they are the same on every run by construction.
       */
      const runs = 12;
      let best = Infinity;
      let total = 0;
      for (let i = 0; i < runs; i++) {
        const started = performance.now();
        drawMap(asContext(probe), scene, view);
        const took = performance.now() - started;
        best = Math.min(best, took);
        total += took;
      }
      report(
        `  frame at 1400x900, ${where.name}: ${best.toFixed(2)}ms best of ${runs}, ` +
          `${(total / runs).toFixed(2)}ms mean · ` +
          `${(probe.fills / runs).toFixed(0)} fills · ${(probe.strokes / runs).toFixed(0)} strokes · ` +
          `${(probe.arcs / runs).toFixed(0)} arcs · ${(probe.texts.length / runs).toFixed(0)} words`,
      );
    }
    expect(true).toBe(true);
  });
});
