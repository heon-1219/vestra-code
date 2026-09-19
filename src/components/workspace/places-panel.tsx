"use client";

import { useMemo, useState } from "react";

import { KIND_WORDS, type GraphItem } from "@/lib/graph/view";

import { districtOf } from "./map/layout";
import type { BeamResult } from "./map/beam";
import { previewTargetFor } from "./preview/file-preview";
import {
  buildTree,
  defaultOpenFolders,
  flattenTree,
  foldersHolding,
  type TreeNode,
} from "./tree";

/**
 * The left panel: what is in this project, listed.
 *
 * Two tabs, and the order is the brief's: features first, files second. Pass 2
 * does not exist yet, so the features tab has nothing to list and says so
 * rather than standing empty — and the files tab is what opens. When features
 * arrive this file changes in one place: `groupsOf` groups by feature instead
 * of by district, and everything below it is unchanged.
 *
 * The grouping is the map's own — `districtOf` — on purpose. A list whose
 * headings are the territories on the map means the two halves of the screen
 * are two views of one thing, and clicking either one selects the same item.
 *
 * **Inside each district the files are a folder tree** ("파일 -> 폴더는 접을 수
 * 있게, 그냥 다 보여주지 말고. VS Code 처럼."). The district heading stays above it
 * rather than being replaced by the tree's own top folders, because the
 * headings are the map's territories and dropping them would leave the two
 * halves of the screen grouped by different things. The two hierarchies do not
 * fight in practice: a district is a folder reading already, so its tree
 * usually starts one compacted row below its heading — 화면 조각 over
 * `src/components` — and never a second, unrelated way of cutting the project.
 * `tree.ts` holds all of the folding logic; this file only draws it.
 */

export type PlacesPanelProps = {
  items: readonly GraphItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /**
   * Open this file and look at it. Undefined means the workspace has nowhere
   * to show one, and then no row offers it.
   */
  onOpen?: (id: string) => void;
  /** What the beam is lighting. Unmatched rows dim; nothing is removed. */
  beam: BeamResult;
  /** True while a run is still filling the graph. */
  loading?: boolean;
};

type Tab = "features" | "files";

/**
 * What the list shows.
 *
 * Files, routes and server addresses — the things that are places in the app.
 * Symbols are deliberately left out: on the demo repo they are two thirds of
 * the graph, and a list of 45 function names in a 15%-wide column is the file
 * tree problem made worse. They are reachable by clicking their file on the
 * map, which is where they live.
 */
const LISTED_KINDS = new Set(["file", "route", "api_endpoint"]);

/**
 * How far one level of folder shifts its rows, and where the shifting stops.
 *
 * The pane drags down to 170px, so indentation is the one thing here that can
 * spend the panel's whole width on nothing: past six levels every name at that
 * width would be an ellipsis. Compaction in `tree.ts` keeps real projects well
 * inside the cap, and a project that reaches it loses the last steps of depth
 * rather than the names.
 */
const INDENT_STEP = 10;
const INDENT_BASE = 8;
const INDENT_MAX_DEPTH = 6;

/**
 * The chevron's gutter, which a file row keeps empty.
 *
 * Without it a file and the folder beside it start at different places and the
 * column reads as ragged rather than as a tree — the chevron would be pushing
 * its own row's name out by a width nothing else has. `w-3` plus the row's
 * `gap-1`.
 */
const CHEVRON_GUTTER = 16;

function indentOf(depth: number): number {
  return INDENT_BASE + Math.min(depth, INDENT_MAX_DEPTH) * INDENT_STEP;
}

type Group = {
  id: string;
  name: string;
  items: GraphItem[];
  byId: Map<string, GraphItem>;
  roots: TreeNode[];
  /** Folders open before anyone has clicked. Decided in `tree.ts`. */
  defaultOpen: Set<string>;
};

function groupsOf(items: readonly GraphItem[]): Group[] {
  const groups = new Map<string, Group>();

  for (const item of items) {
    if (!LISTED_KINDS.has(item.kind)) continue;
    const district = districtOf(item);
    const existing = groups.get(district.id);
    if (existing) existing.items.push(item);
    else
      groups.set(district.id, {
        id: district.id,
        name: district.name,
        items: [item],
        byId: new Map(),
        roots: [],
        defaultOpen: new Set(),
      });
  }

  for (const group of groups.values()) {
    for (const item of group.items) group.byId.set(item.id, item);
    // The district id namespaces every folder key. Two districts can hold the
    // same folder path — `src` is an ancestor of both 공용 기능 and 데이터 — and
    // sharing a key would fold one district's row by clicking the other's.
    group.roots = buildTree(group.items, group.id);
    group.defaultOpen = defaultOpenFolders(group.roots);
  }

  // Largest first: the district with the most in it is the one someone is most
  // likely to be looking for, and it puts the long lists where the eye starts.
  return [...groups.values()].sort(
    (a, b) => b.items.length - a.items.length || (a.name < b.name ? -1 : 1),
  );
}

/**
 * What one row is called.
 *
 * The last segment of the path, and nothing more. It used to carry the folder
 * in front of it wherever a name repeated inside a district — the founder's
 * portfolio has nine project pages, every one of them `index.html`, and nine
 * identical rows name nothing. The tree answers that better than the prefix
 * did: the folder telling them apart is now its own row above them, so the
 * short name is unambiguous in the place it is read.
 */
function basename(item: GraphItem): string {
  if (item.label) return item.label;
  if (!item.path) return item.name;
  const cut = item.path.lastIndexOf("/");
  return cut === -1 ? item.path : item.path.slice(cut + 1);
}

export function PlacesPanel({
  items,
  selectedId,
  onSelect,
  onOpen,
  beam,
  loading = false,
}: PlacesPanelProps) {
  const [tab, setTab] = useState<Tab>("files");

  /**
   * Only the folders a person has actually clicked, and which way they clicked
   * them. Everything else falls through to the default, so re-reading a
   * project (new ids, new folders) does not resurrect a stale open/closed map,
   * and clearing a search cannot lose a fold the user chose while it was on.
   */
  const [folded, setFolded] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  const groups = useMemo(() => groupsOf(items), [items]);
  const hasFeatures = items.some((item) => item.kind === "feature");

  /**
   * What has to be on screen whatever is folded: whatever the beam lit, and
   * whatever is selected. Search reveals rather than filters — the rows it
   * opens stay open only while it is active, which is what lets the user's own
   * folds come back untouched when the input is cleared.
   */
  const revealIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedId !== null) ids.add(selectedId);
    if (beam.active) for (const id of beam.matched) ids.add(id);
    return ids;
  }, [beam, selectedId]);

  const sections = useMemo(
    () =>
      groups.map((group) => {
        const revealed = foldersHolding(group.roots, revealIds);
        const rows = flattenTree(
          group.roots,
          (key) => revealed.has(key) || (folded.get(key) ?? group.defaultOpen.has(key)),
        );
        return { group, rows, revealed };
      }),
    [groups, revealIds, folded],
  );

  const litCount = useMemo(() => {
    if (!beam.active) return 0;
    let count = 0;
    for (const group of groups) {
      for (const item of group.items) if (beam.matched.has(item.id)) count += 1;
    }
    return count;
  }, [beam, groups]);

  const toggle = (key: string, open: boolean) => {
    setFolded((previous) => {
      const next = new Map(previous);
      next.set(key, !open);
      return next;
    });
  };

  return (
    <nav
      aria-label="프로젝트 안의 것들"
      className="flex h-full min-h-0 flex-col border-r border-edge bg-ink-raised"
    >
      <div className="flex shrink-0 gap-1 border-b border-edge px-3 py-2.5">
        <TabButton active={tab === "features"} onClick={() => setTab("features")}>
          기능
        </TabButton>
        <TabButton active={tab === "files"} onClick={() => setTab("files")}>
          파일
        </TabButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {tab === "features" ? (
          <p className="px-2 text-[13px] leading-[1.8] text-said-faint">
            {hasFeatures
              ? "기능 목록을 준비하고 있어요."
              : "기능 이름은 아직 붙이기 전이에요. 지금은 파일로 보여 드릴게요."}
          </p>
        ) : loading && groups.length === 0 ? (
          <p className="px-2 text-[13px] leading-[1.8] text-said-faint">
            아직 읽는 중이에요.
          </p>
        ) : groups.length === 0 ? (
          <p className="px-2 text-[13px] leading-[1.8] text-said-faint">
            보여 드릴 파일이 아직 없어요.
          </p>
        ) : (
          <>
            {beam.active ? (
              <p className="px-2 pb-2 text-[12px] leading-[1.7] text-said-faint">
                {litCount > 0
                  ? `${litCount.toLocaleString("ko-KR")}개를 찾았어요`
                  : "이 이름으로는 못 찾았어요"}
              </p>
            ) : null}

            {sections.map(({ group, rows, revealed }) => (
              <section key={group.id} className="mb-3">
                <h3 className="px-2 pb-1 text-[11px] font-semibold tracking-[0.02em] text-said-faint">
                  {group.name}{" "}
                  <span className="font-mono font-normal">{group.items.length}</span>
                </h3>
                {/*
                  One flat list with `aria-level` rather than a nested
                  `role="tree"`. A tree role promises arrow-key navigation,
                  typeahead and a single tab stop, and a tree that announces
                  itself as one without them strands a keyboard user worse than
                  plain rows would — these are ordinary buttons, reached by Tab,
                  in the order they are read. `aria-level` says how deep a row
                  sits without claiming anything we have not built.
                */}
                <ul>
                  {rows.map((row) => {
                    if (row.kind === "folder") {
                      // A folder holding nothing the beam lit dims exactly as
                      // an unmatched file does, so a search reads the same way
                      // whether what it missed is one row or thirty.
                      const dim = beam.active && !revealed.has(row.key);
                      return (
                        <li
                          key={row.key}
                          aria-level={row.depth + 1}
                          className={`rounded-md transition-colors hover:bg-edge ${
                            dim ? "opacity-35" : ""
                          }`}
                        >
                          {/*
                            The whole row is the control, and the chevron is
                            what it looks like — one tab stop per folder rather
                            than two, and the same target a mouse expects from
                            an explorer. `aria-expanded` is on the button that
                            actually does the folding.

                            Clicking it while the beam is revealing this folder
                            records the choice and does not appear to do
                            anything: the reveal still wins, because a search
                            that reports "3개를 찾았어요" over hidden rows is the
                            worse failure. The fold takes effect when the
                            search is cleared.
                          */}
                          <button
                            type="button"
                            onClick={() => toggle(row.key, row.open)}
                            aria-expanded={row.open}
                            title={row.path}
                            style={{ paddingInlineStart: indentOf(row.depth) }}
                            className="flex w-full min-w-0 items-center gap-1 py-1 pr-2 text-left text-said-soft transition-colors hover:text-said"
                          >
                            {/*
                              One chevron that rotates, not two glyphs that
                              swap. A shape that turns is the same object in a
                              different state, which is what an open folder is;
                              swapping ▸ for ▾ is two characters at two optical
                              weights, and at 10px the pair never quite sit on
                              the same baseline. Drawn rather than typed for the
                              same reason — a font's arrow glyph is whatever
                              that font decided, and this one is 1.5px at every
                              size.
                            */}
                            <svg
                              aria-hidden="true"
                              viewBox="0 0 12 12"
                              className={`h-3 w-3 shrink-0 self-center text-said-faint transition-transform duration-150 ${
                                row.open ? "rotate-90" : ""
                              }`}
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M4.5 2.5 L8 6 L4.5 9.5" />
                            </svg>
                            <span className="truncate text-[13px]">{row.name}</span>
                            <span className="shrink-0 font-mono text-[11px] text-said-faint">
                              {row.count}
                            </span>
                          </button>
                        </li>
                      );
                    }

                    const item = group.byId.get(row.id);
                    // Unreachable: the tree is built from this group's own
                    // items. Kept because a row quietly missing from a list of
                    // someone's own files is the one failure this panel exists
                    // to make impossible.
                    if (!item) return null;

                    // Dimmed, never hidden. A list that empties out as you type
                    // tells someone their project lost the file they were
                    // looking at; the map next to it follows the same rule.
                    const dim = beam.active && !beam.matched.has(item.id);
                    const name = basename(item);
                    // A server address has no file of its own to open, and a
                    // row that offers what it cannot do is worse than a row
                    // that offers nothing.
                    const openable = onOpen !== undefined && previewTargetFor(item) !== null;
                    return (
                      <li
                        key={item.id}
                        aria-level={row.depth + 1}
                        className={`group flex items-center rounded-md transition-colors ${
                          item.id === selectedId ? "bg-edge-lit" : "hover:bg-edge"
                        } ${dim ? "opacity-35" : ""}`}
                      >
                        <button
                          type="button"
                          onClick={() => onSelect(item.id)}
                          title={item.path ?? item.name}
                          aria-current={item.id === selectedId ? "true" : undefined}
                          style={{ paddingInlineStart: indentOf(row.depth) + CHEVRON_GUTTER }}
                          className={`flex min-w-0 flex-1 items-baseline gap-1.5 py-1 pr-2 text-left ${
                            item.id === selectedId ? "text-said" : "text-said-soft"
                          }`}
                        >
                          <span className="truncate text-[13px]">{name}</span>
                          {item.kind !== "file" ? (
                            <span className="shrink-0 text-[11px] text-said-faint">
                              {KIND_WORDS[item.kind]}
                            </span>
                          ) : null}
                        </button>
                        {openable ? (
                          /*
                            Out of the way until it is wanted. The column is
                            150px wide and a permanent second control on every
                            row would take a third of it — but it is only
                            hidden by opacity, so it is still in the tab order
                            and a keyboard reaches it exactly where a mouse
                            does.
                          */
                          <button
                            type="button"
                            onClick={() => onOpen(item.id)}
                            aria-label={`${name} 열어보기`}
                            className="mr-1 shrink-0 rounded px-1.5 py-0.5 text-[11px] text-said-faint opacity-0 transition-opacity hover:text-said focus-visible:opacity-100 group-hover:opacity-100"
                          >
                            열기
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </nav>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md px-2.5 py-1 text-[13px] transition-colors ${
        active ? "bg-edge-lit text-said" : "text-said-faint hover:text-said-soft"
      }`}
    >
      {children}
    </button>
  );
}
