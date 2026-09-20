import { describe, expect, it } from "vitest";

import { isFetchCallee, matchEndpoint, urlPatternOf } from "./fetches";

/**
 * The matching, without a parser.
 *
 * Everything that can go wrong here goes wrong quietly: a wildcard that eats
 * several segments draws an edge to the wrong endpoint, an unmatched call
 * leaves the two halves of an app looking unrelated, and neither shows up as an
 * error anywhere. So the cases are named individually rather than swept into a
 * table.
 */

/** A template's literal chunks, the way the analyzer hands them over. */
const tpl = (...parts: string[]) => urlPatternOf(parts, true);
const lit = (value: string) => urlPatternOf([value], false);

const ROUTES = [
  "/api/orders",
  "/api/orders/[id]",
  "/api/projects/[id]/file",
  "/api/projects/[id]/files",
  "/api/health",
  "/api/files/[...path]",
];

describe("isFetchCallee", () => {
  it("knows the ways fetch is written", () => {
    expect(isFetchCallee("fetch")).toBe(true);
    expect(isFetchCallee("window.fetch")).toBe(true);
    expect(isFetchCallee("globalThis.fetch")).toBe(true);
    expect(isFetchCallee("axios.get")).toBe(true);
    expect(isFetchCallee("axios.post")).toBe(true);
  });

  it("refuses a helper of the user's own that merely looks like one", () => {
    // The cost of being generous is not a missing edge, it is a wrong one: an
    // edge drawn from a place that never talks to that endpoint, on somebody's
    // own app, which nobody would think to check.
    expect(isFetchCallee("get")).toBe(false);
    expect(isFetchCallee("client.get")).toBe(false);
    expect(isFetchCallee("api.post")).toBe(false);
    expect(isFetchCallee("db.delete")).toBe(false);
  });
});

describe("urlPatternOf", () => {
  it("drops the query and the fragment, which are arguments and not addresses", () => {
    expect(lit("/api/orders?page=2")).toBe("/api/orders");
    expect(lit("/api/orders#top")).toBe("/api/orders");
  });

  it("refuses anything that is not a path on this origin", () => {
    // An edge to a route of ours that happens to share a path with someone
    // else's host would be wrong in a way nobody would ever look for.
    expect(lit("https://api.github.com/repos")).toBeNull();
    expect(lit("//cdn.example.com/x")).toBeNull();
    expect(lit("orders")).toBeNull();
    expect(urlPatternOf([], false)).toBeNull();
  });
});

describe("matchEndpoint", () => {
  it("matches a URL written out in full, and calls it certain", () => {
    expect(matchEndpoint(lit("/api/orders")!, ROUTES)).toEqual({
      urlPath: "/api/orders",
      confidence: "certain",
    });
  });

  it("matches an interpolated segment against a dynamic route, as a guess", () => {
    // `/api/projects/${id}/file` is the route, and the wildcard is ours rather
    // than the router's — so the edge exists and is drawn as inferred.
    const pattern = tpl("/api/projects/", "/file")!;
    expect(matchEndpoint(pattern, ROUTES)).toEqual({
      urlPath: "/api/projects/[id]/file",
      confidence: "inferred",
    });
  });

  it("does not let one wildcard swallow several segments", () => {
    // The failure that would make this feature useless: `/api/${rest}` matching
    // every endpoint in the project and picking one of them.
    const pattern = tpl("/api/", "")!;
    expect(matchEndpoint(pattern, ROUTES)).toBeNull();
  });

  it("says nothing when two endpoints fit equally well", () => {
    // `/api/projects/${id}/${which}` fits both `file` and `files`. Choosing is
    // inventing a fact about someone's code.
    const pattern = tpl("/api/projects/", "/", "")!;
    expect(matchEndpoint(pattern, ROUTES)).toBeNull();
  });

  it("prefers the literal route over a dynamic one that also fits", () => {
    // `/api/orders` is written out, so it is that route, even though a
    // hypothetical `/api/[section]` would also accept it.
    const withCatchAllSibling = [...ROUTES, "/api/[section]"];
    expect(matchEndpoint(lit("/api/orders")!, withCatchAllSibling)).toEqual({
      urlPath: "/api/orders",
      confidence: "certain",
    });
  });

  it("matches a catch-all only when something is left for it to catch", () => {
    expect(matchEndpoint(lit("/api/files/a/b/c")!, ROUTES)).toEqual({
      urlPath: "/api/files/[...path]",
      confidence: "certain",
    });
    // `/api/files` does not reach `/api/files/[...path]`.
    expect(matchEndpoint(lit("/api/files")!, ROUTES)).toBeNull();
  });

  it("refuses a path that is shorter or longer than every route", () => {
    expect(matchEndpoint(lit("/api")!, ROUTES)).toBeNull();
    expect(matchEndpoint(lit("/api/orders/1/extra")!, ROUTES)).toBeNull();
  });

  it("matches an interpolation that is only part of a segment", () => {
    // `page-${n}.json` is one segment however much of it is written out.
    const pattern = tpl("/api/orders/report-", ".json")!;
    expect(matchEndpoint(pattern, ["/api/orders/[file]"])).toEqual({
      urlPath: "/api/orders/[file]",
      confidence: "inferred",
    });
  });

  it("finds nothing when the app has no endpoints at all", () => {
    expect(matchEndpoint(lit("/api/orders")!, [])).toBeNull();
  });
});
