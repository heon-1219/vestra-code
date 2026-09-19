import { describe, expect, it } from "vitest";

import { FALLBACK, hueFor, withAlpha } from "./palette";

describe("withAlpha", () => {
  it("reads a six-digit token", () => {
    expect(withAlpha("#d98e5f", 0.5)).toBe("rgba(217, 142, 95, 0.5)");
  });

  it("reads a three-digit token as its doubled form", () => {
    expect(withAlpha("#abc", 1)).toBe(withAlpha("#aabbcc", 1));
  });

  it("does not care about the whitespace a computed style may carry", () => {
    expect(withAlpha("  #d98e5f ", 0.5)).toBe(withAlpha("#d98e5f", 0.5));
  });

  it("answers the same string for the same request, which is what the cache is for", () => {
    expect(withAlpha("#7fa88c", 0.42)).toBe(withAlpha("#7fa88c", 0.42));
  });
});

describe("hueFor", () => {
  it("gives each territory its own colour while the grouping means something", () => {
    expect(hueFor(FALLBACK, 0, true)).toBe(FALLBACK.hues[0]);
    expect(hueFor(FALLBACK, 2, true)).toBe(FALLBACK.hues[2]);
  });

  it("wraps rather than running off the end of the palette", () => {
    expect(hueFor(FALLBACK, FALLBACK.hues.length, true)).toBe(FALLBACK.hues[0]);
  });

  /**
   * The founder's rule, in one assertion. Colour on this map means "which
   * place is this in"; where there is no grouping worth showing it means
   * nothing, and six colours that mean nothing look exactly like six that do.
   */
  it("spends no colour at all when the grouping is not saying anything", () => {
    expect(hueFor(FALLBACK, 0, false)).toBe(FALLBACK.plain);
    expect(hueFor(FALLBACK, 4, false)).toBe(FALLBACK.plain);
  });
});
