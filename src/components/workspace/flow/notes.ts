import {
  alternativesNote,
  certaintyNote,
  guessedAddressNote,
  type FlowMargin,
  type FlowNote,
  type FlowPath,
} from "@/lib/graph/flow";
import type { GraphItem } from "@/lib/graph/view";

/**
 * §7's longer sentences, for whichever path is on screen.
 *
 * `FlowTrace.notes` already carries these — for the **top** path. The panel
 * lets a reader switch to one of the runner-ups, because §7's own alternatives
 * sentence ends "아래에서 바꿔 볼 수 있어요" and a sentence that offers something
 * the screen does not do is the failure this whole document is written against.
 * The moment a second path can be showing, notes computed for the first one are
 * about a path nobody is reading.
 *
 * Every sentence here comes from `flow.ts`'s own exported writers —
 * `guessedAddressNote`, `certaintyNote`, `alternativesNote` — so there is one
 * place each of these sentences is worded, and this file only decides which of
 * them apply. That is the D69 rule read carefully: two *rankings* for one idea
 * is the failure, and so are two wordings; choosing which of one module's
 * sentences fit the path currently on screen is not a second copy of anything.
 *
 * **It is still a rule stated twice**, and the better fix is upstream: `flow.ts`
 * computes exactly this in a private `notesFor`, and if that took the path
 * rather than assuming the best one, this file would be four lines calling it.
 * That change is offered rather than made, because `lib/graph/` is finished and
 * pinned by 84 tests.
 */
export function flowNotes(
  path: FlowPath,
  itemsById: ReadonlyMap<string, GraphItem>,
  margin: FlowMargin,
  others: number,
): FlowNote[] {
  const notes: FlowNote[] = [];

  for (const hop of path.hops) {
    // A `fetches` the parser marked `inferred` is a wildcard address: a `${…}`
    // stood in for a segment, so we know the shape and not the address.
    if (hop.relation !== "fetches" || hop.certainty !== "inferred") continue;
    const address = itemsById.get(hop.toId)?.name;
    if (!address) continue;
    notes.push({ kind: "guessed-address", hop: hop.index, text: guessedAddressNote(address) });
  }

  const guessed = path.hops.filter((hop) => hop.certainty === "inferred").length;
  if (guessed > 0) {
    // Said once, at the top, because certainty is the weakest link on a path
    // and not the last one: a label taken from hop twelve would launder a guess
    // made at hop six into a fact.
    notes.push({ kind: "certainty", hop: null, text: certaintyNote(path.hops.length, guessed) });
  }

  if (others > 0 && margin.close) {
    notes.push({ kind: "alternatives", hop: null, text: alternativesNote(others) });
  }

  return notes;
}
