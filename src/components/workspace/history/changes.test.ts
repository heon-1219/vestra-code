import { describe, expect, it } from "vitest";

import {
  changeFacts,
  changeHeadline,
  litSentence,
  shapeWords,
  shortChangeSha,
  type ChangeDetail,
  type FileStatus,
} from "./changes";

/**
 * The sentences one change gets.
 *
 * Every case here is one where the tidy answer and the true answer come apart.
 * A commit whose file list GitHub withheld looks exactly like a commit that
 * changed nothing; a change that touched only a lockfile lights nothing and
 * must say so rather than leave a click looking unregistered; and the counts
 * are the one place a wrong plural or a dropped category would read as a fact
 * about somebody's own project.
 */

function detail(over: Partial<ChangeDetail> = {}): ChangeDetail {
  return {
    sha: "0123456789abcdef0123456789abcdef01234567",
    title: "결제 화면을 고쳤어요",
    body: null,
    authorName: "David",
    at: "2026-09-20T09:14:22.000Z",
    files: [],
    fileListTruncated: false,
    fileListMissing: false,
    itemIds: [],
    ...over,
  };
}

const files = (...statuses: FileStatus[]) =>
  statuses.map((status, index) => ({
    path: `src/file-${index}.ts`,
    status,
    onMap: true,
  }));

describe("changeHeadline", () => {
  it("counts the files that moved", () => {
    expect(changeHeadline(detail({ files: files("modified", "added") }))).toBe(
      "파일 2개가 달라졌어요",
    );
  });

  it("says nothing changed only when nothing changed", () => {
    expect(changeHeadline(detail())).toBe("바뀐 파일이 없어요");
  });

  it("never reports a withheld list as an empty one", () => {
    // The two are identical in the data and opposite as claims. A merge whose
    // files GitHub declined to list would otherwise be announced, on the
    // screen of the person who made it, as having changed nothing.
    expect(changeHeadline(detail({ fileListMissing: true }))).toBe(
      "바뀐 파일을 확인하지 못했어요",
    );
  });
});

describe("changeFacts", () => {
  it("breaks the count down in a fixed order", () => {
    const facts = changeFacts(
      detail({
        files: files("removed", "added", "renamed", "modified", "modified"),
      }),
    );
    expect(facts).toEqual([
      "새로 생긴 파일 1개",
      "고친 파일 2개",
      "없어진 파일 1개",
      "이름이 바뀐 파일 1개",
    ]);
  });

  it("leaves out the kinds that did not happen", () => {
    expect(changeFacts(detail({ files: files("modified") }))).toEqual([
      "고친 파일 1개",
    ]);
  });

  it("says nothing at all when the list was withheld", () => {
    // Not "고친 파일 0개": that is a measurement nobody took.
    expect(
      changeFacts(detail({ fileListMissing: true, files: [] })),
    ).toEqual([]);
  });
});

describe("litSentence", () => {
  it("says how many places on the map were lit", () => {
    expect(litSentence(detail({ itemIds: ["a", "b", "c"] }))).toBe(
      "지도에서 3곳을 밝혔어요. 나머지는 흐리게 보일 뿐 그대로 있어요.",
    );
  });

  it("still answers when a changed file is one dot and nothing finer", () => {
    /*
     * The ordinary case on a project the shallow analyzer read: it places
     * files and no pieces, so a commit to one file lights exactly one place.
     * The sentence has to work at one as well as at ninety — this is the
     * count most of this product's real projects will produce.
     */
    expect(
      litSentence(detail({ files: files("modified"), itemIds: ["file-1"] })),
    ).toBe("지도에서 1곳을 밝혔어요. 나머지는 흐리게 보일 뿐 그대로 있어요.");
  });

  it("says out loud when a change touched nothing on the map", () => {
    // A README, a lockfile, a config the analyzer does not place. Common, and
    // a silent nothing after a click reads as a click that did not register.
    expect(litSentence(detail({ files: files("modified") }))).toBe(
      "이 변경이 건드린 곳은 지도에 없어요. 지도는 그대로 둘게요.",
    );
  });
});

describe("shapeWords", () => {
  it("says nothing about an ordinary change", () => {
    expect(shapeWords({ merge: false, split: false })).toEqual([]);
  });

  it("writes out what the picture shows, for anyone who cannot see it", () => {
    expect(shapeWords({ merge: true, split: false })).toEqual([
      "갈라졌던 것이 여기서 합쳐졌어요",
    ]);
    expect(shapeWords({ merge: true, split: true })).toEqual([
      "갈라졌던 것이 여기서 합쳐졌어요",
      "여기에서 갈라졌어요",
    ]);
  });
});

describe("shortChangeSha", () => {
  it("is the seven characters every other tool shows", () => {
    expect(shortChangeSha("0123456789abcdef0123456789abcdef01234567")).toBe(
      "0123456",
    );
  });

  it("does not pad a sha that is already short", () => {
    expect(shortChangeSha("abc123 ")).toBe("abc123");
  });
});
