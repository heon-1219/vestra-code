"use client";

import { useMemo, useState } from "react";

import { KIND_WORDS, type GraphItem } from "@/lib/graph/view";

import { districtOf } from "./map/layout";
import type { BeamResult } from "./map/beam";
import { previewTargetFor } from "./preview/file-preview";

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

type Group = { id: string; name: string; items: GraphItem[]; labels: Map<string, string> };

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
        labels: new Map(),
      });
  }

  for (const group of groups.values()) {
    group.labels = labelsFor(group.items);
  }

  // Largest first: the district with the most in it is the one someone is most
  // likely to be looking for, and it puts the long lists where the eye starts.
  return [...groups.values()].sort(
    (a, b) => b.items.length - a.items.length || (a.name < b.name ? -1 : 1),
  );
}

/** The last path segment. The full path is the title attribute. */
function basename(item: GraphItem): string {
  if (item.label) return item.label;
  if (!item.path) return item.name;
  const cut = item.path.lastIndexOf("/");
  return cut === -1 ? item.path : item.path.slice(cut + 1);
}

/**
 * What each row is called, decided for the whole group at once.
 *
 * A basename on its own is not always a name. The founder's portfolio has nine
 * project pages, every one of them `index.html`, and nine identical rows in a
 * narrow column name nothing — you cannot tell which one you are about to
 * click. Where a name repeats inside a district, the folder that distinguishes
 * them is put in front of it; where it does not, the short name stands alone.
 */
function labelsFor(items: readonly GraphItem[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const base = basename(item);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }

  const labels = new Map<string, string>();
  for (const item of items) {
    const base = basename(item);
    if ((counts.get(base) ?? 0) < 2 || !item.path) {
      labels.set(item.id, base);
      continue;
    }
    const parts = item.path.split("/");
    const parent = parts.length > 1 ? parts[parts.length - 2] : null;
    labels.set(item.id, parent ? `${parent}/${base}` : base);
  }
  return labels;
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

  const groups = useMemo(() => groupsOf(items), [items]);
  const hasFeatures = items.some((item) => item.kind === "feature");

  const litCount = useMemo(() => {
    if (!beam.active) return 0;
    let count = 0;
    for (const group of groups) {
      for (const item of group.items) if (beam.matched.has(item.id)) count += 1;
    }
    return count;
  }, [beam, groups]);

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

            {groups.map((group) => (
              <section key={group.id} className="mb-3">
                <h3 className="px-2 pb-1 text-[11px] font-semibold tracking-[0.02em] text-said-faint">
                  {group.name}{" "}
                  <span className="font-mono font-normal">{group.items.length}</span>
                </h3>
                <ul>
                  {group.items.map((item) => {
                    // Dimmed, never hidden. A list that empties out as you type
                    // tells someone their project lost the file they were
                    // looking at; the map next to it follows the same rule.
                    const dim = beam.active && !beam.matched.has(item.id);
                    const name = group.labels.get(item.id) ?? item.name;
                    // A server address has no file of its own to open, and a
                    // row that offers what it cannot do is worse than a row
                    // that offers nothing.
                    const openable = onOpen !== undefined && previewTargetFor(item) !== null;
                    return (
                      <li
                        key={item.id}
                        className={`group flex items-center rounded-md transition-colors ${
                          item.id === selectedId ? "bg-edge-lit" : "hover:bg-edge"
                        } ${dim ? "opacity-35" : ""}`}
                      >
                        <button
                          type="button"
                          onClick={() => onSelect(item.id)}
                          title={item.path ?? item.name}
                          aria-current={item.id === selectedId ? "true" : undefined}
                          className={`flex min-w-0 flex-1 items-baseline gap-1.5 px-2 py-1 text-left ${
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
