import { describe, expect, it } from "vitest";

import { classifyRoute } from "./routes";

describe("App Router", () => {
  it("maps page files to the address a person types", () => {
    expect(classifyRoute("app/page.tsx")).toEqual({ kind: "route", urlPath: "/" });
    expect(classifyRoute("app/checkout/page.tsx")).toEqual({
      kind: "route",
      urlPath: "/checkout",
    });
    expect(classifyRoute("src/app/cart/page.jsx")).toEqual({
      kind: "route",
      urlPath: "/cart",
    });
  });

  it("maps route handlers to API endpoints", () => {
    expect(classifyRoute("app/api/data/route.js")).toEqual({
      kind: "api_endpoint",
      urlPath: "/api/data",
    });
    expect(classifyRoute("app/api/auth/[...nextauth]/route.js")).toEqual({
      kind: "api_endpoint",
      urlPath: "/api/auth/:nextauth*",
    });
  });

  it("drops route groups, which organise files without appearing in the URL", () => {
    expect(classifyRoute("app/(marketing)/about/page.tsx")).toEqual({
      kind: "route",
      urlPath: "/about",
    });
    expect(classifyRoute("app/(shop)/(sale)/deals/page.tsx")).toEqual({
      kind: "route",
      urlPath: "/deals",
    });
  });

  it("drops parallel route slots", () => {
    expect(classifyRoute("app/@modal/login/page.tsx")).toEqual({
      kind: "route",
      urlPath: "/login",
    });
  });

  it("handles dynamic, catch-all and optional catch-all segments", () => {
    expect(classifyRoute("app/blog/[slug]/page.tsx")).toEqual({
      kind: "route",
      urlPath: "/blog/:slug",
    });
    expect(classifyRoute("app/docs/[...path]/page.tsx")).toEqual({
      kind: "route",
      urlPath: "/docs/:path*",
    });
    // An optional catch-all also matches its parent, so it adds nothing required.
    expect(classifyRoute("app/shop/[[...filters]]/page.tsx")).toEqual({
      kind: "route",
      urlPath: "/shop",
    });
  });

  it("ignores files that are not pages or handlers", () => {
    expect(classifyRoute("app/layout.tsx")).toBeNull();
    expect(classifyRoute("app/globals.css")).toBeNull();
    expect(classifyRoute("app/loading.tsx")).toBeNull();
    expect(classifyRoute("app/checkout/PayButton.tsx")).toBeNull();
  });

  it("ignores intercepting routes, which are not their own address", () => {
    expect(classifyRoute("app/feed/(..)photo/[id]/page.tsx")).toBeNull();
  });
});

describe("Pages Router", () => {
  it("maps pages, treating index as its directory", () => {
    expect(classifyRoute("pages/index.jsx")).toEqual({ kind: "route", urlPath: "/" });
    expect(classifyRoute("pages/about.tsx")).toEqual({
      kind: "route",
      urlPath: "/about",
    });
    expect(classifyRoute("pages/blog/index.tsx")).toEqual({
      kind: "route",
      urlPath: "/blog",
    });
    expect(classifyRoute("pages/blog/[slug].tsx")).toEqual({
      kind: "route",
      urlPath: "/blog/:slug",
    });
  });

  it("maps pages/api to endpoints", () => {
    expect(classifyRoute("pages/api/hello.js")).toEqual({
      kind: "api_endpoint",
      urlPath: "/api/hello",
    });
    expect(classifyRoute("pages/api/user/[id].ts")).toEqual({
      kind: "api_endpoint",
      urlPath: "/api/user/:id",
    });
  });

  it("ignores framework machinery a user never visits", () => {
    expect(classifyRoute("pages/_app.tsx")).toBeNull();
    expect(classifyRoute("pages/_document.tsx")).toBeNull();
  });
});

describe("outside the routing directories", () => {
  it("returns nothing", () => {
    expect(classifyRoute("components/Tracker.jsx")).toBeNull();
    expect(classifyRoute("lib/plan.js")).toBeNull();
    expect(classifyRoute("package.json")).toBeNull();
    // A directory merely named app deeper in the tree is not the router.
    expect(classifyRoute("packages/app/page.tsx")).toBeNull();
  });
});
