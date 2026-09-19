import type { ProjectKind } from "@/analysis/types";

/**
 * Deciding what a repository is, from its file list alone.
 *
 * Runs on the tree API response before anything is downloaded, so we can tell
 * someone what we will be able to show them in about a second rather than after
 * a hundred-megabyte wait.
 *
 * Three deep classes plus a shallow fallback, not a ladder of frameworks. Every
 * framework we cannot resolve symbols for produces the same outcome — the
 * shallow map from D26 — so the only reason to recognise one by name is to say
 * its name back to the user, which is kinder than "unknown".
 */

export type Detection = {
  kind: ProjectKind;
  /** Shown to the user. Plain language, no graph vocabulary. */
  summary: string;
  /** True when a language-specific analyzer will produce `certain` edges. */
  deep: boolean;
  /** What we matched on, for the decision log and for debugging. */
  signals: string[];
};

/** A package.json found somewhere in the repo, with its path. */
export type PackageManifest = { path: string; json: unknown };

const DENY_PREFIXES = [
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  "coverage/",
  ".git/",
];

function isVendored(path: string): boolean {
  return DENY_PREFIXES.some(
    (prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
  );
}

function dependencyNames(packageJson: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof packageJson !== "object" || packageJson === null) return names;
  const record = packageJson as Record<string, unknown>;
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ] as const) {
    const map = record[field];
    if (typeof map === "object" && map !== null) {
      for (const name of Object.keys(map)) names.add(name);
    }
  }
  return names;
}

/**
 * Frameworks we recognise but cannot yet read deeply. Naming them is purely so
 * the message can say what the project is instead of shrugging.
 */
const KNOWN_SHALLOW: { dep: string; label: string }[] = [
  { dep: "solid-js", label: "SolidJS" },
  { dep: "svelte", label: "Svelte" },
  { dep: "vue", label: "Vue" },
  { dep: "@angular/core", label: "Angular" },
  { dep: "astro", label: "Astro" },
  { dep: "nuxt", label: "Nuxt" },
  { dep: "@remix-run/react", label: "Remix" },
  { dep: "preact", label: "Preact" },
];

/** Any of these means the HTML is a bundler entry point, not a hand-written page. */
const BUNDLER_CONFIG =
  /^(?:[^/]+\/)?(vite|webpack|rollup|parcel|snowpack|rsbuild|esbuild)\.config\.[cm]?[jt]s$/;

export function detectProject(
  allPaths: string[],
  manifests: PackageManifest[],
): Detection {
  const paths = allPaths.filter((path) => !isVendored(path));
  const signals: string[] = [];

  const deps = new Set<string>();
  for (const manifest of manifests) {
    for (const name of dependencyNames(manifest.json)) deps.add(name);
  }

  const manifestPaths = paths.filter(
    (path) => path === "package.json" || path.endsWith("/package.json"),
  );
  const hasBundlerConfig = paths.some((path) => BUNDLER_CONFIG.test(path));

  const has = (predicate: (path: string) => boolean) => paths.some(predicate);

  if (deps.has("next")) {
    signals.push("package.json에 next 의존성");
    if (has((p) => /(^|\/)(src\/)?app\/.*\/?(page|layout|route)\.(tsx?|jsx?)$/.test(p))) {
      signals.push("app/ 라우트 파일");
    }
    if (has((p) => /(^|\/)(src\/)?pages\/.+\.(tsx?|jsx?)$/.test(p))) {
      signals.push("pages/ 라우트 파일");
    }
    return {
      kind: "nextjs",
      deep: true,
      summary: "Next.js 프로젝트예요. 페이지와 화면 조각까지 자세히 읽을 수 있어요.",
      signals,
    };
  }

  // Checked before React, because several of these ship React as a transitive
  // or optional dependency and would otherwise be misread as a React app.
  const shallowFramework = KNOWN_SHALLOW.find((entry) => deps.has(entry.dep));
  if (shallowFramework) {
    signals.push(`package.json에 ${shallowFramework.dep} 의존성`);
    return {
      kind: "unsupported",
      deep: false,
      summary: `${shallowFramework.label}로 만든 프로젝트예요. 아직 이 종류는 자세히 읽지 못해요. 파일과 폴더, 어떤 도구를 쓰는지, 서로 불러 쓰는 관계까지는 지도로 그려드릴 수 있어요. 그중 일부는 확실하고, 일부는 짐작이에요.`,
      signals,
    };
  }

  if (deps.has("react")) {
    signals.push("package.json에 react 의존성");
    return {
      kind: "react_spa",
      deep: true,
      summary: "React 프로젝트예요. 화면 조각과 그 연결까지 자세히 읽을 수 있어요.",
      signals,
    };
  }

  const htmlFiles = paths.filter((path) => /\.html?$/i.test(path));

  /**
   * A static site means HTML somebody wrote by hand — not an `index.html` that
   * a bundler uses as its entry point.
   *
   * This distinction was not hypothetical: a SolidJS app in this account was
   * classified as a hand-written site because its package.json sits under
   * `frontend/` rather than at the root, leaving exactly one index.html and no
   * visible dependency. The product would have promised to read its pages and
   * styles and then produced almost nothing.
   */
  const looksBundled = manifestPaths.length > 0 || hasBundlerConfig;

  if (htmlFiles.length > 0 && !looksBundled) {
    signals.push(`HTML 파일 ${htmlFiles.length}개`);
    if (has((path) => /\.css$/i.test(path))) signals.push("CSS 파일");
    return {
      kind: "static_site",
      deep: true,
      summary:
        "HTML로 만든 사이트예요. 페이지끼리의 연결과 스타일이 어디에 쓰이는지 읽을 수 있어요.",
      signals,
    };
  }

  if (looksBundled) {
    signals.push(
      manifestPaths.length > 0
        ? `package.json ${manifestPaths.length}개 (${manifestPaths.slice(0, 3).join(", ")})`
        : "번들러 설정 파일",
    );
  } else {
    signals.push("알고 있는 프레임워크 신호 없음");
  }

  // Never "unsupported" in the user's words (D26). We still draw a map; we are
  // just honest that it is the shallower one.
  return {
    kind: "unsupported",
    deep: false,
    summary:
      "아직 자세히 읽지 못하는 종류의 프로젝트예요. 파일과 폴더, 어떤 도구를 쓰는지, 그리고 서로 불러 쓰는 관계까지는 지도로 그려드릴 수 있어요. 그중 일부는 확실하고, 일부는 짐작이에요.",
    signals,
  };
}

/**
 * Which package.json files to fetch before detecting.
 *
 * The root one is often not the only one and sometimes not there at all — a
 * repo with `frontend/` and `backend/` keeps the interesting one a level down.
 * Bounded to a handful of the shallowest so detection stays one second rather
 * than one API call per workspace in a monorepo.
 */
export function manifestsToFetch(allPaths: string[], limit = 4): string[] {
  return allPaths
    .filter(
      (path) =>
        !isVendored(path) &&
        (path === "package.json" || path.endsWith("/package.json")),
    )
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, limit);
}
