import { describe, expect, it } from "vitest";

import { SOURCE } from "./__fixtures__/project";
import {
  asText,
  linesOf,
  MATCH_LINE_CHARS,
  matchesIn,
  MAX_LINE_CHARS,
  MAX_WINDOW_CHARS,
  MAX_WINDOW_LINES,
  normalisePath,
  probablyText,
  renderWindow,
  SOURCE_MAX_BYTES,
  WHOLE_FILE_CHARS,
  WHOLE_FILE_LINES,
  windowOf,
} from "./source";

/**
 * The caps, without a network or a database.
 *
 * Everything worth getting wrong here is arithmetic about somebody's file:
 * which lines come back, what they are numbered, and what gets cut. A line
 * number that is off by one makes every citation in an answer wrong while
 * looking exactly right.
 */

describe("linesOf", () => {
  it("counts lines the way an editor does", () => {
    // "a\nb\n" is two lines to a person and three elements to `split`. Telling
    // someone their file has a line 3 they cannot see makes every other number
    // in the answer suspect.
    expect(linesOf("a\nb\n")).toEqual(["a", "b"]);
    expect(linesOf("a\nb")).toEqual(["a", "b"]);
  });

  it("keeps a blank line the author actually wrote", () => {
    expect(linesOf("a\n\n\n")).toEqual(["a", "", ""]);
  });

  it("reads a file written on Windows", () => {
    expect(linesOf("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  it("treats an empty file as one empty line rather than none", () => {
    expect(linesOf("")).toEqual([""]);
  });
});

describe("windowOf", () => {
  const text = SOURCE["src/lib/format.ts"];

  it("returns the lines asked for, numbered from one", () => {
    const window = windowOf("src/lib/format.ts", text, 3, 3);
    expect(window.startLine).toBe(3);
    expect(window.endLine).toBe(5);
    expect(window.lines.map((line) => line.number)).toEqual([3, 4, 5]);
    expect(window.lines[0].text).toContain("export function formatPrice");
    expect(window.totalLines).toBe(12);
  });

  it("stops at the end of the file and says where it stopped", () => {
    const window = windowOf("src/lib/format.ts", text, 11, 40);
    expect(window.startLine).toBe(11);
    expect(window.endLine).toBe(12);
  });

  it("clamps a line number past the end rather than refusing", () => {
    // What a model asks when it has the wrong file. The honest reply is the end
    // of the file with its real numbers on it, from which the mistake is
    // visible; the header always states the range actually returned.
    const window = windowOf("src/lib/format.ts", text, 900, 5);
    expect(window.startLine).toBe(12);
    expect(window.endLine).toBe(12);
  });

  it("never returns more than the ceiling, whatever is asked for", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
    const window = windowOf("big.ts", long, 1, 9_000);
    expect(window.lines.length).toBe(MAX_WINDOW_LINES);
  });

  it("cuts a minified line instead of spending the budget on it", () => {
    // One `bundle.js` is a single line of forty thousand characters. Without
    // this, one tool call eats the whole input budget.
    const window = windowOf("bundle.js", "x".repeat(40_000), 1, 1);
    expect(window.clipped).toBe(true);
    expect(window.lines[0].text.length).toBeLessThan(MAX_LINE_CHARS + 20);
  });

  it("stops early when the window itself gets heavy, and says so", () => {
    const dense = Array.from({ length: 80 }, () => "y".repeat(150)).join("\n");
    const window = windowOf("dense.ts", dense, 1, 80);
    expect(window.shortened).toBe(true);
    expect(window.endLine).toBeLessThan(80);
    const chars = window.lines.reduce((sum, line) => sum + line.text.length, 0);
    expect(chars).toBeLessThanOrEqual(MAX_WINDOW_CHARS + 150);
  });
});

describe("renderWindow", () => {
  const text = SOURCE["src/lib/format.ts"];

  it("puts the number on every line and the file's length in the header", () => {
    const rendered = renderWindow(windowOf("src/lib/format.ts", text, 6, 2));
    expect(rendered).toContain("src/lib/format.ts 6-7줄 (전체 12줄)");
    expect(rendered).toContain("    7| ");
    // The citation the model has to produce back is a line number, and counting
    // down from a header is where an off-by-four comes from.
    expect(rendered).toContain('toLocaleString("en-US")');
  });

  it("says there is more below rather than letting the window imply an ending", () => {
    const rendered = renderWindow(windowOf("src/lib/format.ts", text, 1, 4));
    expect(rendered).toContain("5줄부터는");
  });

  it("says nothing more when the window reaches the end", () => {
    const rendered = renderWindow(windowOf("src/lib/format.ts", text, 1, 12));
    expect(rendered).not.toContain("줄부터는");
  });
});

describe("normalisePath", () => {
  it("spells a path the way the map spells it", () => {
    expect(normalisePath("./src/lib/format.ts")).toBe("src/lib/format.ts");
    expect(normalisePath("/src/lib/format.ts")).toBe("src/lib/format.ts");
    expect(normalisePath("src\\lib\\format.ts")).toBe("src/lib/format.ts");
    expect(normalisePath("  src/lib/format.ts  ")).toBe("src/lib/format.ts");
  });
});

describe("asText", () => {
  it("decodes source", () => {
    const bytes = new TextEncoder().encode("한 줄\n두 줄\n");
    expect(asText(bytes)).toEqual({ ok: true, text: "한 줄\n두 줄\n" });
  });

  it("refuses something that is not text", () => {
    // An uploaded project keeps images beside its code (D77). Decoding a PNG as
    // UTF-8 produces thousands of replacement characters that look exactly like
    // a file worth reading on.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]);
    expect(asText(bytes)).toEqual({ ok: false, reason: "not_text" });
  });

  it("refuses a file past the ceiling before decoding it", () => {
    const bytes = new Uint8Array(SOURCE_MAX_BYTES + 1);
    expect(asText(bytes)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("matchesIn", () => {
  const TEXT = [
    "import stripe",
    "",
    "def pay(amount):",
    "    return stripe.charge(amount)  # STRIPE",
  ].join("\n");

  it("gives the line number a citation can be made of", () => {
    expect(matchesIn(TEXT, "def pay", 3)).toEqual([
      { line: 3, text: "def pay(amount):" },
    ]);
  });

  it("does not care about case, because a person searching does not", () => {
    expect(matchesIn(TEXT, "STRIPE", 5).map((m) => m.line)).toEqual([1, 4]);
    expect(matchesIn(TEXT, "stripe", 5).map((m) => m.line)).toEqual([1, 4]);
  });

  it("stops at the limit, which is per file", () => {
    const many = Array.from({ length: 50 }, () => "stripe").join("\n");
    expect(matchesIn(many, "stripe", 3)).toHaveLength(3);
  });

  it("clips a long line rather than returning it", () => {
    const wide = `x = "${"결".repeat(400)}"`;
    const [match] = matchesIn(wide, "x =", 1);
    // Ten of these come back where a read returns one line, so the per-line
    // cost is what decides whether the whole result stays near a window.
    expect(match.text.length).toBeLessThan(MATCH_LINE_CHARS + 10);
    expect(match.text).toContain("줄임");
  });

  it("finds nothing for an empty needle rather than everything", () => {
    expect(matchesIn(TEXT, "", 5)).toEqual([]);
  });
});

describe("probablyText", () => {
  it("keeps source, prose and config", () => {
    for (const path of [
      "bot.py",
      "src/lib/format.ts",
      "README.md",
      "pyproject.toml",
      "requirements.txt",
      "Dockerfile",
      "Makefile",
    ]) {
      expect(probablyText(path), path).toBe(true);
    }
  });

  it("skips what a search would only waste a fetch on", () => {
    // An uploaded project keeps images and PDFs beside its code (D77), and a
    // content search fetches speculatively.
    for (const path of [
      "tests/fixtures/chatlog_baseline.png",
      "docs/manual.pdf",
      "public/font.woff2",
      "package-lock.json",
      "yarn.lock",
      "go.sum",
    ]) {
      expect(probablyText(path), path).toBe(false);
    }
  });
});

describe("a window asked to be longer", () => {
  it("honours the bigger ceiling, and is still a ceiling", () => {
    const long = Array.from({ length: 400 }, (_, n) => `line ${n + 1}`).join("\n");
    const whole = windowOf("x.ts", long, 1, WHOLE_FILE_LINES, {
      maxLines: WHOLE_FILE_LINES,
      maxChars: WHOLE_FILE_CHARS,
    });
    expect(whole.lines).toHaveLength(WHOLE_FILE_LINES);
    expect(whole.endLine).toBe(WHOLE_FILE_LINES);
    // And it says there is more, which is what makes a clamp not a lie.
    expect(renderWindow(whole)).toContain("줄부터는 다시 요청하면");
  });

  it("means exactly what it meant before the limits existed when none are passed", () => {
    const long = Array.from({ length: 400 }, (_, n) => `line ${n + 1}`).join("\n");
    expect(windowOf("x.ts", long, 1, 999).lines).toHaveLength(MAX_WINDOW_LINES);
  });
});
