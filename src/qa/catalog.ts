import { KIND_WORDS, type GraphItem } from "@/lib/graph/view";

/**
 * Numbering the graph so the model can point at it without ever seeing an id.
 *
 * D46: node ids are hashes, and a hash in a prompt is paid for twice — once
 * going in and once coming back — for no information at all. Sequential
 * integers cut that about fivefold and turn "the model invented an id" into a
 * bounds check, which is the difference between validating a hash and hoping.
 *
 * The numbers are positions in the array the caller was given, and `load.ts`
 * already orders that array deterministically (path, then line, then name). So
 * the same graph numbers the same way on every run, which is what lets a test
 * assert `[3]` and what lets two investigations of one project be compared.
 * Nothing here mutates: a lazily-assigned number would depend on what the model
 * happened to search for first.
 */
export type Catalog = {
  /** In the order they were given. Index + 1 is the number the model sees. */
  readonly items: readonly GraphItem[];
  /** Null rather than a throw: a number from a truncated reply is normal input. */
  at(n: number): GraphItem | null;
  numberOf(id: string): number | null;
};

export function buildCatalog(items: readonly GraphItem[]): Catalog {
  const numbers = new Map<string, number>();
  items.forEach((item, index) => numbers.set(item.id, index + 1));

  return {
    items,
    at(n) {
      if (!Number.isInteger(n) || n < 1 || n > items.length) return null;
      return items[n - 1];
    },
    numberOf(id) {
      return numbers.get(id) ?? null;
    },
  };
}

/**
 * One item on one line, which is the unit of everything the model reads.
 *
 * Every field here earns its tokens:
 *
 *   - the number, so it can be opened;
 *   - the code name, because that is what appears in the source it will read;
 *   - the kind in Korean, so a 조각 is not mistaken for a 파일;
 *   - the path and line range, because that IS the citation it will have to
 *     produce later — a shape the model never sees is a shape it gets wrong;
 *   - the plain-language label, only when Pass 2 has produced one and it says
 *     something the code name does not;
 *   - how many places use it, only when that is not zero, because "쓰임 0" on
 *     every line of a search result is forty wasted tokens.
 */
export function itemLine(catalog: Catalog, item: GraphItem): string {
  const number = catalog.numberOf(item.id);
  const parts: string[] = [
    `[${number ?? "?"}] ${item.name} (${KIND_WORDS[item.kind]})`,
  ];
  if (item.path) parts.push(item.path + lineSuffix(item));
  if (item.label && item.label !== item.name) parts.push(item.label);
  if (item.usedBy > 0) parts.push(`쓰임 ${item.usedBy}`);
  return parts.join(" · ");
}

/**
 * `:12-88`, or nothing.
 *
 * A file node has no line range — the whole file is its range — and printing
 * `:null-null` would be an invitation to cite it. The absence is the signal:
 * to cite inside a file you have to read it.
 */
function lineSuffix(item: GraphItem): string {
  if (item.startLine === null) return "";
  if (item.endLine === null || item.endLine === item.startLine) {
    return `:${item.startLine}`;
  }
  return `:${item.startLine}-${item.endLine}`;
}
