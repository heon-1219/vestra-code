/**
 * A list of paths, folded into folders.
 *
 * The left panel listed every file flat under its district heading, and the
 * founder asked for the explorer everyone already knows: "파일 -> 폴더는 접을 수
 * 있게, 그냥 다 보여주지 말고. VS Code 처럼."
 *
 * Everything here is the pure half of that — paths in, rows out — because what
 * is *visible* after a fold, a search and a selection is the part that goes
 * wrong silently. A file one collapsed folder away looks exactly like a file
 * the tool lost, and this panel's oldest rule — nothing ever vanishes — is the
 * one a person checks their whole project against. A test that never renders
 * anything is the only way to pin it.
 *
 * Four rules this file keeps:
 *
 *  1. **Nothing is dropped.** An item with no path at all is still a row, at
 *     the top of its tree, under the district heading that names it. No branch
 *     here can return fewer items than it was given.
 *  2. **A chain of single folders is one row.** VS Code's compacted folders.
 *     `src/app/(marketing)/components/hero` is one child all the way down, and
 *     as five rows with five indents it costs five clicks to reach one file
 *     while telling the reader nothing they could not read off one line.
 *  3. **Folding is per folder, never per level.** Two folders at the same depth
 *     hold different amounts; a level-wide "depth 2 is closed" would shut a
 *     three-file folder to save nothing and leave a forty-file one open.
 *  4. **Deterministic.** Same items in, same rows out, in the same order, for
 *     ever — the promise `layout.ts` makes, for the same reason: a panel that
 *     reshuffles between two runs of an unchanged project cannot be read as a
 *     picture of the project.
 */

/** Everything the tree needs from an item. `GraphItem` satisfies this. */
export type TreeItem = {
  id: string;
  name: string;
  path: string | null;
};

export type FolderNode = {
  kind: "folder";
  /**
   * Unique across the whole panel, which is what the caller's prefix buys.
   * Two districts can genuinely hold the same folder path — `src` is an
   * ancestor of both `src/lib` (공용 기능) and `src/db` (데이터) — and without the
   * prefix, folding one of those two rows would fold the other one with it.
   */
  key: string;
  /** The folder's own path. Shown on hover, so a row is never a bare name. */
  path: string;
  /** What the row reads. Several segments when a chain was compacted. */
  name: string;
  children: TreeNode[];
  /**
   * Items underneath, at any depth. A closed folder is the one place this
   * panel is allowed to hide something, so it says how much it is holding.
   */
  count: number;
};

export type ItemNode = { kind: "item"; id: string };

export type TreeNode = FolderNode | ItemNode;

export type FolderRow = FolderNode & { depth: number; open: boolean };
export type ItemRow = ItemNode & { depth: number };
export type TreeRow = FolderRow | ItemRow;

/**
 * How many rows a district may open to on a first look.
 *
 * The panel is one narrow column holding every district stacked, so rows spent
 * on one district are headings pushed off the bottom for all the others — and
 * the flat list this replaces was exactly that failure, at full size.
 *
 * On a project the size of the demo repo (22 files spread across its
 * districts) every district fits and the panel opens whole, so the fold costs
 * a small project nothing. It starts closing folders only on a project big
 * enough for the flat list to have been the complaint.
 *
 * A district whose entire content is one large folder therefore opens as a
 * single row saying how many are inside. That is deliberate: "그냥 다 보여주지
 * 말고" is the ask, the count keeps it honest, and it is one click away.
 */
export const DEFAULT_OPEN_ROWS = 12;

/**
 * Build one district's tree.
 *
 * @param prefix Namespaces the folder keys. The panel passes the district id;
 * see `FolderNode.key` for what goes wrong without it.
 */
export function buildTree(items: readonly TreeItem[], prefix = ""): TreeNode[] {
  const root: Draft = { path: [], folders: new Map(), items: [] };

  for (const item of items) {
    // An item with no path is not an error and is not droppable — a server
    // address has no file of its own. It sits at the top of the district,
    // which is a named place, rather than in an invented folder: we do not
    // know where it lives, and a folder called 어디 있는지 모르는 것 would be us
    // writing a fact about their project that we made up.
    const segments = item.path === null ? [] : directorySegments(item.path);
    draftAt(root, segments).items.push(item);
  }

  return childrenOf(root, prefix);
}

/**
 * Which folders are open before anyone has clicked anything.
 *
 * Widest first, and a folder opens only while what it adds still fits the
 * budget. Breadth-first rather than depth-first because the shallow rows are
 * the ones that describe the whole district; spending the budget down one deep
 * branch would open a leaf folder while its neighbours stayed shut.
 *
 * A folder too big for what is left of the budget is skipped and its smaller
 * siblings are still considered — an `assets` folder with forty images in it
 * should not close a three-file folder standing next to it.
 */
export function defaultOpenFolders(
  roots: readonly TreeNode[],
  budget: number = DEFAULT_OPEN_ROWS,
): Set<string> {
  // Nothing is open to begin with.
  //
  // The first version opened folders breadth-first while the rows they added
  // still fit a budget, on the reasoning that a small project should look the
  // way it always had. That reasoning was about the old flat list, not about
  // what a tree is for: the founder's instruction was "그냥 다 보여주지 말고",
  // and a tree that arrives already unfolded is a list with extra indentation.
  // Shut, the panel opens as one row per folder — the shape of the project,
  // which is the thing you are looking at this panel to see.
  //
  // The budget is kept in the signature rather than deleted because the search
  // and the selection still compute what to reveal, and a caller that wants a
  // partially open tree has somewhere to ask for one.
  void roots;
  void budget;
  return new Set<string>();
}

/**
 * Every folder holding one of these items, at any depth.
 *
 * Two callers, one answer: the beam (a match inside a closed folder has to
 * open it, or the panel reports "3개를 찾았어요" over rows that are not on
 * screen) and the selection (the thing the map has highlighted must be visible
 * beside it). Ancestors come back too and not merely the immediate parent,
 * because opening the parent of a buried match reveals nothing while the
 * grandparent is still shut.
 */
export function foldersHolding(
  roots: readonly TreeNode[],
  ids: ReadonlySet<string>,
): Set<string> {
  const found = new Set<string>();
  if (ids.size === 0) return found;
  for (const node of roots) {
    if (isFolder(node)) markHolders(node, ids, found);
  }
  return found;
}

/** The rows to draw, top to bottom. A closed folder's children are not rows. */
export function flattenTree(
  roots: readonly TreeNode[],
  isOpen: (key: string) => boolean,
): TreeRow[] {
  const rows: TreeRow[] = [];

  const push = (nodes: readonly TreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.kind === "item") {
        rows.push({ ...node, depth });
        continue;
      }
      const open = isOpen(node.key);
      rows.push({ ...node, depth, open });
      if (open) push(node.children, depth + 1);
    }
  };

  push(roots, 0);
  return rows;
}

export function isFolder(node: TreeNode): node is FolderNode {
  return node.kind === "folder";
}

type Draft = {
  /** Segments from the root of this tree, which the key is built from. */
  path: string[];
  folders: Map<string, Draft>;
  items: TreeItem[];
};

/**
 * The folders an item's path passes through.
 *
 * Paths are repo-relative with POSIX separators, and this normalises anyway
 * for the reason `layout.ts` does: a folder uploaded from a Windows machine is
 * one `\` away from becoming a single folder named after the whole path, and
 * the two halves of the screen must not disagree about where a file lives.
 */
function directorySegments(path: string): string[] {
  const cleaned = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const cut = cleaned.lastIndexOf("/");
  if (cut === -1) return [];
  return cleaned
    .slice(0, cut)
    .split("/")
    .filter((segment) => segment !== "");
}

function draftAt(root: Draft, segments: readonly string[]): Draft {
  let node = root;
  for (const segment of segments) {
    let next = node.folders.get(segment);
    if (!next) {
      next = { path: [...node.path, segment], folders: new Map(), items: [] };
      node.folders.set(segment, next);
    }
    node = next;
  }
  return node;
}

function childrenOf(draft: Draft, prefix: string): TreeNode[] {
  const folders = [...draft.folders.values()]
    .map((child) => toFolder(child, prefix))
    .sort((a, b) => compareNames(a.name, b.name));

  // Folders above files, each alphabetically: the explorer order, and the one
  // a person scanning a narrow column can lean on without being told it.
  const items = [...draft.items]
    .sort((a, b) => compareNames(leafName(a), leafName(b)) || compareNames(a.id, b.id))
    .map<ItemNode>((item) => ({ kind: "item", id: item.id }));

  return [...folders, ...items];
}

function toFolder(draft: Draft, prefix: string): FolderNode {
  // Rule 2: walk down while this folder holds nothing but one other folder, and
  // print the whole chain on one row. `current` ends on the deepest folder of
  // the chain, so the key is the path the row actually opens.
  let current = draft;
  const segments = [lastSegment(draft)];
  while (current.items.length === 0 && current.folders.size === 1) {
    const [only] = [...current.folders.values()];
    segments.push(lastSegment(only));
    current = only;
  }

  const children = childrenOf(current, prefix);
  const path = current.path.join("/");
  return {
    kind: "folder",
    key: prefix === "" ? path : `${prefix}/${path}`,
    path,
    name: segments.join("/"),
    children,
    count: children.reduce(
      (total, child) => total + (child.kind === "item" ? 1 : child.count),
      0,
    ),
  };
}

function lastSegment(draft: Draft): string {
  return draft.path[draft.path.length - 1] ?? "";
}

function leafName(item: TreeItem): string {
  if (!item.path) return item.name;
  const cut = item.path.lastIndexOf("/");
  return cut === -1 ? item.path : item.path.slice(cut + 1);
}

/**
 * Case-insensitive first, then exact.
 *
 * `README.md` should not sort a block away from `api/` because of its capitals,
 * and the exact comparison behind it keeps the order total — two names
 * differing only in case must still have one answer, or the rows swap places
 * between two runs of the same project.
 */
function compareNames(a: string, b: string): number {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function markHolders(
  folder: FolderNode,
  ids: ReadonlySet<string>,
  found: Set<string>,
): boolean {
  let holds = false;
  for (const child of folder.children) {
    if (child.kind === "item") {
      if (ids.has(child.id)) holds = true;
    } else if (markHolders(child, ids, found)) {
      holds = true;
    }
  }
  if (holds) found.add(folder.key);
  return holds;
}
