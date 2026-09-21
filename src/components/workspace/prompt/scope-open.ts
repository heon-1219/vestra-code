import type { LockMap } from "@/components/workspace/panel/connection-row";

/**
 * The place an "only here" answer opened, and the prompt it belongs to.
 *
 * Kept beside the remembered locks, never inside them (D172). A lock map is
 * remembered by id for the whole visit, so writing the place into it opened
 * that place for every later prompt that listed it — an "everywhere" prompt
 * about the same selection included — as though the person had flipped a
 * switch they never touched.
 */
export type ScopeOpened = { selectionId: string; placeId: string };

/**
 * The locks the panel's switches show.
 *
 * The opened place reads 편집 허용 only while the prompt that opened it is in
 * front and its selection is the one selected: that is when the list on screen
 * has to say what that prompt told the agent. Everywhere else the switches are
 * exactly what the person set.
 */
export function locksShown(
  locks: LockMap,
  opened: ScopeOpened | null,
  showing: { promptInFront: boolean; selectedId: string | null },
): LockMap {
  if (!opened || !showing.promptInFront || opened.selectionId !== showing.selectedId) return locks;
  return { ...locks, [opened.placeId]: "editable" };
}
