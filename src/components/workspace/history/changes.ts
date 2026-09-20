import { z } from "zod";

/**
 * The project's own history, and the words for it.
 *
 * `runs.ts` beside this file describes *our* readings of a project — dated
 * snapshots of the map. This one describes what the person actually did to
 * their project: the repository's commits, drawn as a branch graph. They are
 * two different histories of one thing and the band shows both, joined at the
 * one column that can join them, `analysis_runs.commit_sha`.
 *
 * Three decisions live here rather than in the component.
 *
 *   1. **A commit is a 변경, never a 커밋.** The band is called 변경 기록 and
 *      its reader cannot read code; 커밋 is a word from the tool, not from the
 *      work. The one piece of jargon kept is the short SHA, for the same
 *      reason `runs.ts` keeps it — it is the one thing here somebody might
 *      paste somewhere else — and it carries the same explanatory hover.
 *   2. **The vocabulary stops where `view.ts` draws the line.** A place on the
 *      map is a 곳, which is the word the map's own status line already uses.
 *      Never 조각: `KIND_WORDS` spends 조각 on a symbol specifically, and the
 *      set a change lights is files and pages and pieces together, so 조각 N개
 *      would be a false sentence whenever one of them was a file.
 *   3. **Nothing here is allowed to round.** GitHub lists at most 300 files
 *      for one commit and says nothing when it stops; a commit that touched
 *      more comes back looking exactly like one that touched 300. So the
 *      ceiling is reported as a note rather than absorbed into the count, and
 *      a commit whose file list GitHub withheld says that instead of saying
 *      zero.
 */

export const fileStatusSchema = z.enum([
  "added",
  "removed",
  "modified",
  "renamed",
]);

export type FileStatus = z.infer<typeof fileStatusSchema>;

/**
 * One change as the band receives it, and as the route must send it.
 *
 * Schema first and the type derived from it, the same way `runs.ts` does it:
 * the route's mapping is checked against this by the compiler and the browser
 * checks the bytes against the same shape at the boundary, so the two ends
 * cannot drift.
 */
export const changeRecordSchema = z.object({
  sha: z.string(),
  /** Full SHAs, git's order. Two or more is a merge. */
  parents: z.array(z.string()),
  /** The message's first line — the person's own words. */
  title: z.string(),
  authorName: z.string().nullable(),
  /** ISO, or empty when GitHub carried no readable date. */
  at: z.string(),
  /**
   * The run that drew a map from this exact change, when there is one.
   *
   * An id and not a copy of the run: the band already holds the run list and
   * can look the rest up, so the sentence about what that run changed is
   * computed by `runHeadline` and by nothing else. One fact, one place.
   */
  drawnRunId: z.string().nullable(),
});

export type ChangeRecord = z.infer<typeof changeRecordSchema>;

export const changesResponseSchema = z.object({
  /**
   * Why this project has no history to draw, or null when it has one.
   *
   * Three separate answers rather than one, because they are three different
   * situations and only one of them is anybody's fault. None of them is a
   * failure, and none may be drawn as an empty graph: a picture of a history
   * with nothing in it says the project has no past, which for an uploaded
   * folder is not true — it has one, we were simply never shown it.
   *
   *   - `upload` — a folder from somebody's own machine was never a
   *     repository, so there is no commit history at all.
   *   - `unknown_repo` — a GitHub project whose owner or name we never
   *     recorded. Rare, and there is nothing to ask GitHub about.
   *   - `empty` — the repository exists and has no commits yet.
   */
  none: z.enum(["upload", "unknown_repo", "empty"]).nullable(),
  changes: z.array(changeRecordSchema),
  /** True when the branch has history older than what was sent. */
  truncated: z.boolean(),
});

export type ChangesResponse = z.infer<typeof changesResponseSchema>;

export type NoHistoryReason = NonNullable<ChangesResponse["none"]>;

/**
 * What each of those three says out loud.
 *
 * Next to the enum so a fourth reason cannot be added without somebody having
 * to write its sentence, which is the same rule `RELATION_WORDS` follows in
 * `view.ts`. Each one says what is true and what it means for this screen —
 * never "실패했어요", because none of them is a failure.
 */
export const NO_HISTORY_WORDS: Record<NoHistoryReason, string> = {
  upload:
    "내 컴퓨터에서 올린 폴더라서, 코드를 바꿔 온 기록은 없어요. 그 기록은 GitHub 저장소에서만 가져올 수 있어요.",
  unknown_repo:
    "이 프로젝트가 어느 저장소에서 왔는지 남아 있지 않아서, 바꿔 온 기록을 가져올 수 없어요.",
  empty: "저장소에 아직 아무것도 올라가지 않았어요.",
};

export const changedFileSchema = z.object({
  /** Repo-relative, POSIX separators — the spelling the map holds (D18). */
  path: z.string(),
  status: fileStatusSchema,
  /** True when something at this path is on the map and was lit. */
  onMap: z.boolean(),
});

export type ChangedFileRecord = z.infer<typeof changedFileSchema>;

export const changeDetailSchema = z.object({
  sha: z.string(),
  title: z.string(),
  /** Whatever else the message said. */
  body: z.string().nullable(),
  authorName: z.string().nullable(),
  at: z.string(),
  files: z.array(changedFileSchema),
  /** True when GitHub's 300-file ceiling cut the list short. */
  fileListTruncated: z.boolean(),
  /** True when GitHub sent no file list. Not the same as "nothing changed". */
  fileListMissing: z.boolean(),
  /** The places on the map that live in one of those files. */
  itemIds: z.array(z.string()),
});

export type ChangeDetail = z.infer<typeof changeDetailSchema>;

/** The word each kind of change gets, in the list of files. */
export const STATUS_WORDS: Record<FileStatus, string> = {
  added: "새로 생겼어요",
  removed: "없어졌어요",
  modified: "고쳤어요",
  renamed: "이름이 바뀌었어요",
};

/** The same four, counted. Read as "새로 생긴 파일 2개". */
const COUNT_WORDS: Record<FileStatus, string> = {
  added: "새로 생긴 파일",
  removed: "없어진 파일",
  modified: "고친 파일",
  renamed: "이름이 바뀐 파일",
};

/** Fixed, so two changes with the same counts always read the same way. */
const COUNT_ORDER: readonly FileStatus[] = [
  "added",
  "modified",
  "removed",
  "renamed",
];

const ko = (n: number) => n.toLocaleString("ko-KR");

export const TRUNCATED_NOTE =
  "GitHub이 파일 300개까지만 알려줘서, 실제로는 더 바뀌었을 수 있어요.";

export const MISSING_NOTE =
  "GitHub이 바뀐 파일 목록을 주지 않아서, 어디가 달라졌는지는 알 수 없어요.";

/**
 * The one line a change gets when it is opened.
 *
 * Three answers, and the order of the checks is the whole point: a commit
 * whose file list we were never given must not be described as one that
 * changed nothing. They look identical in the data and they are opposite
 * claims about somebody's own work.
 */
export function changeHeadline(detail: ChangeDetail): string {
  if (detail.fileListMissing) return "바뀐 파일을 확인하지 못했어요";
  const total = detail.files.length;
  if (total === 0) return "바뀐 파일이 없어요";
  return `파일 ${ko(total)}개가 달라졌어요`;
}

/**
 * The breakdown, for the places there is room for it.
 *
 * A list rather than one sentence, deliberately. Four categories joined by
 * Korean particles is grammar with four shapes to get wrong and no way to
 * check it at a glance — `changedSentence` in `runs.ts` does that for exactly
 * two numbers and is already the longest function in this folder.
 */
export function changeFacts(detail: ChangeDetail): string[] {
  if (detail.fileListMissing) return [];

  const counts = new Map<FileStatus, number>();
  for (const file of detail.files) {
    counts.set(file.status, (counts.get(file.status) ?? 0) + 1);
  }

  const facts: string[] = [];
  for (const status of COUNT_ORDER) {
    const count = counts.get(status) ?? 0;
    if (count > 0) facts.push(`${COUNT_WORDS[status]} ${ko(count)}개`);
  }
  return facts;
}

/**
 * What the map was asked to do about this change.
 *
 * Zero is a real and common answer — a change to a README, to a lockfile, to
 * a config the analyzer does not put on the map — and it has to be said out
 * loud. A silent nothing after a click reads as a click that did not register,
 * and the map going dim with nothing lit would be worse: it would suggest the
 * change touched something we simply failed to find.
 */
export function litSentence(detail: ChangeDetail): string {
  const lit = detail.itemIds.length;
  if (lit === 0) {
    return "이 변경이 건드린 곳은 지도에 없어요. 지도는 그대로 둘게요.";
  }
  return `지도에서 ${ko(lit)}곳을 밝혔어요. 나머지는 흐리게 보일 뿐 그대로 있어요.`;
}

/**
 * What a change's shape is, in words, for the row and for a screen reader.
 *
 * The branch graph says merge and split with a picture, and a picture is not
 * reachable by anyone who cannot see it — so the same two facts are written
 * out. Empty for an ordinary change, which is most of them, so the row does
 * not carry a label saying "nothing special".
 */
export function shapeWords(node: {
  merge: boolean;
  split: boolean;
}): string[] {
  const words: string[] = [];
  if (node.merge) words.push("갈라졌던 것이 여기서 합쳐졌어요");
  if (node.split) words.push("여기에서 갈라졌어요");
  return words;
}

/**
 * The first seven characters, exactly as `runs.ts` does it.
 *
 * Written again rather than imported so that neither file's rule can be
 * changed on behalf of the other: `runs.ts` shortens the SHA *we recorded for
 * a run*, this shortens the SHA *GitHub gave us for a change*, and the day one
 * of those wants a different length the other must not silently follow.
 */
export function shortChangeSha(sha: string): string {
  return sha.trim().slice(0, 7);
}
