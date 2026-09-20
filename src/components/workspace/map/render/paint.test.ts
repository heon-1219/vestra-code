import { describe, expect, it } from "vitest";

import type { GraphConnection, GraphItem } from "@/lib/graph/view";

import { IDLE_BEAM } from "../beam";
import { layoutMap } from "../layout";

import { drawMap, type Scene, type View } from "./paint";
import { FALLBACK } from "./palette";
import {
  buildAdjacency,
  buildLinks,
  focusOf,
  hubsOf,
  NO_FOCUS,
  NO_TRAIL,
} from "./scene";
import { trailFrom } from "./walk";

/**
 * A stand-in for a 2D context that remembers what it was asked to draw.
 *
 * It exists for one test, and that test is the reason this module was worth
 * splitting out of the component at all: **panning must not change which
 * connections are carrying words.** The obvious level-of-detail rule — count
 * what is inside the viewport — makes every label on screen blink out when you
 * drag towards a busy corner, and no amount of tuning fixes it. The only way to
 * check that the rule does not do that is to draw the same scene from two
 * camera positions and compare.
 *
 * It also gives the frame a place to be timed from a plain script, with no
 * browser and no React in the way.
 */
class Recorder {
  fillStyle: string | CanvasGradient = "";
  strokeStyle: string | CanvasGradient = "";
  lineWidth = 1;
  lineCap = "butt";
  font = "";
  textAlign = "left";
  textBaseline = "alphabetic";
  shadowColor = "";
  shadowBlur = 0;
  letterSpacing = "0px";

  /** Every piece of text, with where it landed and which pass drew it. */
  texts: { text: string; x: number; y: number; baseline: string }[] = [];
  strokes = 0;
  fills = 0;

  private tx = 0;
  private ty = 0;
  private rot = 0;
  private stack: { tx: number; ty: number; rot: number }[] = [];

  setTransform(): void {}
  fillRect(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  quadraticCurveTo(): void {}
  closePath(): void {}
  fill(): void {
    this.fills++;
  }
  stroke(): void {
    this.strokes++;
  }
  createRadialGradient(): { addColorStop: () => void } {
    return { addColorStop: () => {} };
  }
  // Every Korean glyph is about the same width, so a flat six pixels per
  // character is close enough for a rule that only asks "does this fit".
  measureText(text: string): { width: number } {
    return { width: text.length * 6 };
  }
  save(): void {
    this.stack.push({ tx: this.tx, ty: this.ty, rot: this.rot });
  }
  restore(): void {
    const previous = this.stack.pop();
    if (previous) {
      this.tx = previous.tx;
      this.ty = previous.ty;
      this.rot = previous.rot;
    }
  }
  translate(x: number, y: number): void {
    const cos = Math.cos(this.rot);
    const sin = Math.sin(this.rot);
    this.tx += x * cos - y * sin;
    this.ty += x * sin + y * cos;
  }
  rotate(angle: number): void {
    this.rot += angle;
  }
  fillText(text: string, x: number, y: number): void {
    const cos = Math.cos(this.rot);
    const sin = Math.sin(this.rot);
    this.texts.push({
      text,
      x: this.tx + x * cos - y * sin,
      y: this.ty + x * sin + y * cos,
      baseline: this.textBaseline,
    });
  }
}

/**
 * The recorder is not a `CanvasRenderingContext2D` and cannot be: that
 * interface carries images, paths, filters and a dozen other things this
 * renderer never touches, and stubbing them would be fiction. The cast is the
 * narrowest honest statement — "the painter only uses the part implemented
 * above" — and if that ever stops being true the painter throws here rather
 * than drawing something wrong on screen.
 */
function asContext(recorder: Recorder): CanvasRenderingContext2D {
  return recorder as unknown as CanvasRenderingContext2D;
}

function item(partial: Partial<GraphItem> & { id: string }): GraphItem {
  return {
    kind: "file",
    shape: null,
    name: partial.id,
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

const ITEMS: GraphItem[] = [
  item({ id: "a", path: "src/lib/a.ts", usedBy: 2 }),
  item({ id: "b", path: "src/lib/b.ts", usedBy: 1 }),
  item({ id: "c", path: "src/lib/c.ts" }),
  item({ id: "d", path: "src/lib/d.ts" }),
  item({ id: "e", path: "src/components/e.tsx", usedBy: 3 }),
  item({ id: "f", path: "src/components/f.tsx" }),
  item({ id: "g", path: "src/components/g.tsx" }),
  item({ id: "h", path: "src/components/h.tsx" }),
];

const CONNECTIONS: GraphConnection[] = [
  { id: "1", from: "a", to: "b", relation: "calls", certainty: "certain" },
  { id: "2", from: "c", to: "d", relation: "imports", certainty: "inferred" },
  { id: "3", from: "e", to: "f", relation: "renders", certainty: "certain" },
  { id: "4", from: "b", to: "f", relation: "calls", certainty: "certain" },
  { id: "5", from: "c", to: "g", relation: "imports", certainty: "certain" },
  { id: "6", from: "a", to: "h", relation: "calls", certainty: "inferred" },
];

const LAYOUT = layoutMap(ITEMS);
const LINKS = buildLinks(ITEMS, CONNECTIONS, LAYOUT);
const ADJACENCY = buildAdjacency(LINKS);

function sceneWith(over: Partial<Scene> = {}): Scene {
  return {
    layout: LAYOUT,
    roads: [],
    links: LINKS,
    itemsById: new Map(ITEMS.map((one) => [one.id, one])),
    hubs: hubsOf(LAYOUT, ITEMS),
    grouped: true,
    beam: IDLE_BEAM,
    selection: NO_FOCUS,
    pointed: NO_FOCUS,
    selectedId: null,
    trail: NO_TRAIL,
    size: { width: 1600, height: 1200 },
    ...over,
  };
}

function viewWith(over: Partial<View> = {}): View {
  return {
    width: 1600,
    height: 1200,
    dpr: 1,
    camera: { x: 70, y: 0, scale: 2 },
    palette: FALLBACK,
    font: "sans-serif",
    fitScale: 0.3,
    ...over,
  };
}

/** Relation labels are the only text drawn on a middle baseline. */
function relationLabels(recorder: Recorder) {
  return recorder.texts.filter((one) => one.baseline === "middle");
}

function paint(scene: Scene, view: View): Recorder {
  const recorder = new Recorder();
  drawMap(asContext(recorder), scene, view);
  return recorder;
}

describe("drawMap, level of detail", () => {
  it("says nothing about a connection at a zoom where the line is not even drawn", () => {
    const recorder = paint(sceneWith(), viewWith({ fitScale: 1, camera: { x: 70, y: 0, scale: 0.6 } }));
    expect(relationLabels(recorder)).toHaveLength(0);
  });

  it("writes the relation on the line once there is room to read it", () => {
    const recorder = paint(sceneWith(), viewWith());
    const labels = relationLabels(recorder);
    expect(labels.length).toBeGreaterThan(0);
    // The words come from the table in view.ts and are never invented here.
    for (const label of labels) {
      expect(["사용해요", "불러와요", "그려요", "가지고 있어요", "받아와요", "가져다 써요", "속해요"]).toContain(
        label.text,
      );
    }
  });

  /**
   * The flicker test. Same zoom, two camera positions, everything still inside
   * a viewport large enough to hold the whole map: the labels must be the same
   * labels, moved by exactly the amount the map moved. A rule that counted
   * what is on screen would fail this the moment the two views held different
   * numbers of connections.
   */
  it("labels the same connections wherever the map has been dragged to", () => {
    const before = relationLabels(paint(sceneWith(), viewWith()));
    const after = relationLabels(
      paint(sceneWith(), viewWith({ camera: { x: 90, y: 0, scale: 2 } })),
    );

    expect(after.map((one) => one.text)).toEqual(before.map((one) => one.text));
    for (const [index, label] of after.entries()) {
      expect(label.x).toBeCloseTo(before[index].x - 40, 6);
      expect(label.y).toBeCloseTo(before[index].y, 6);
    }
  });

  /**
   * The one case where words are always worth drawing: the user has just asked
   * what this thing is joined to, and the answer is written on the lines
   * leaving it — at a zoom where nothing else on the map is saying anything.
   */
  it("still names a selection's own connections below every other threshold", () => {
    const quiet = viewWith({ fitScale: 1, camera: { x: 70, y: 0, scale: 0.6 } });
    expect(relationLabels(paint(sceneWith(), quiet))).toHaveLength(0);

    const chosen = sceneWith({
      selectedId: "b",
      selection: focusOf("b", ADJACENCY),
      pointed: focusOf("b", ADJACENCY),
    });
    expect(relationLabels(paint(chosen, quiet)).length).toBeGreaterThan(0);
  });
});

describe("drawMap, what it costs", () => {
  it("draws strictly less when the map is zoomed away from", () => {
    const near = paint(sceneWith(), viewWith());
    const far = paint(sceneWith(), viewWith({ camera: { x: 70, y: 0, scale: 0.08 } }));
    expect(far.strokes + far.fills).toBeLessThan(near.strokes + near.fills);
  });
});

/**
 * The walk, drawn.
 *
 * `walk.test.ts` proves the translation and `scene.test.ts` proves the
 * strengths; what is left for the painter is the thing neither can see — that
 * the sequence actually reaches the canvas, and reaches it at the zoom where a
 * person is most likely to be reading it.
 */
function walkTrail() {
  const point = (id: string, critical = false) => ({
    id,
    number: 0,
    step: 1,
    leg: 1,
    critical,
  });
  const hop = (connectionId: string, from: string, to: string) => ({
    connectionId,
    from,
    to,
    relation: "calls" as const,
    certainty: "certain" as const,
    step: 1,
    via: "opened" as const,
  });

  // a → b → f. Nothing in this fixture joins a to f, so the picture has to get
  // its shape from the hops rather than from which dots are lit.
  return trailFrom({
    points: [point("a"), point("b"), point("f", true)],
    hops: [hop("1", "a", "b"), hop("4", "b", "f")],
    unplaced: [],
  });
}

/**
 * A crossing number, drawn alone or in front of the relation word.
 *
 * Asserted as a shape rather than by counting labels: how many of a walk's
 * lines are long enough to carry text is geometry, and it changes with the
 * layout, the zoom and the size of the container. What must not change is that
 * every word on the map during a walk belongs to the walk.
 */
const NUMBERED = /^\d+( · .+)?$/;

describe("drawMap, the walk", () => {
  const QUIET = viewWith({ fitScale: 1, camera: { x: 70, y: 0, scale: 0.6 } });

  it("numbers the crossings even at a zoom that says nothing about connections", () => {
    // The same view draws no relation words at all, which is the baseline this
    // is measured against. The `rankCeiling` budget that silences ordinary
    // connections must not silence the answer to the question just asked.
    expect(relationLabels(paint(sceneWith(), QUIET))).toHaveLength(0);

    const labels = relationLabels(paint(sceneWith({ trail: walkTrail() }), QUIET));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.text).toMatch(NUMBERED);
  });

  it("writes on no line but the ones the walk crossed", () => {
    const quiet = relationLabels(paint(sceneWith(), viewWith()));
    // Six connections, and at this zoom several of them ordinarily get named.
    expect(quiet.length).toBeGreaterThan(2);

    const labels = relationLabels(paint(sceneWith({ trail: walkTrail() }), viewWith()));
    expect(labels.length).toBeGreaterThan(0);
    // Every one of them is a crossing. A bare relation word here would be a
    // line competing with the walk for the same glance.
    for (const label of labels) expect(label.text).toMatch(NUMBERED);
    expect(labels.length).toBeLessThan(quiet.length);
  });

  it("stands the selection's neighbourhood down rather than drawing two answers", () => {
    /*
     * `b` is on the walk and has connections the walk did not cross. With no
     * walk those get named as the selection's own neighbourhood, below every
     * other threshold. With one, the walk owns the lines — otherwise the map
     * shows a bright neighbourhood and a bright path at once and nothing says
     * which of them answers the question.
     */
    const chosen = {
      selectedId: "b",
      selection: focusOf("b", ADJACENCY),
      pointed: focusOf("b", ADJACENCY),
    };

    expect(relationLabels(paint(sceneWith(chosen), QUIET)).length).toBeGreaterThan(0);

    const labels = relationLabels(
      paint(sceneWith({ ...chosen, trail: walkTrail() }), QUIET),
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.text).toMatch(NUMBERED);
  });
});
