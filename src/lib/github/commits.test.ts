import { describe, expect, it } from "vitest";

import { changedPaths, splitMessage, type ChangedFile } from "./commits";

/**
 * The join between a commit and the map.
 *
 * `changedPaths` is the only thing standing between "GitHub says these files
 * changed" and "these places light up", and every way it can fail is silent: a
 * path that does not match simply lights nothing, which looks exactly like a
 * change that touched nothing on the map. Both are sentences this product
 * says, and only one of them is ever true at a time.
 */

const file = (over: Partial<ChangedFile> = {}): ChangedFile => ({
  path: "src/app/page.tsx",
  status: "modified",
  previousPath: null,
  ...over,
});

describe("changedPaths", () => {
  it("gives back the paths a commit touched", () => {
    expect(
      changedPaths([file({ path: "a.ts" }), file({ path: "b.ts" })]),
    ).toEqual(["a.ts", "b.ts"]);
  });

  it("normalises the spelling the ids were hashed from", () => {
    /*
     * D18. A leading `./`, a leading slash, a doubled slash and a backslash
     * from a commit authored on Windows are four spellings of one file, and
     * only one of them is what `nodes.file_path` holds. Matching without this
     * is a change that lights nothing and says so, which is a lie in the shape
     * of a true sentence.
     */
    expect(
      changedPaths([
        file({ path: "./src/app/page.tsx" }),
        file({ path: "/src/app/page.tsx" }),
        file({ path: "src//app/page.tsx" }),
        file({ path: "src\\app\\page.tsx" }),
      ]),
    ).toEqual(["src/app/page.tsx"]);
  });

  it("counts a renamed file under both of its names", () => {
    // The map may predate the rename or postdate it, and it is the same file
    // either way. Lighting it under whichever name the map happens to hold is
    // the honest answer; picking one would light nothing half the time.
    expect(
      changedPaths([
        file({
          path: "src/checkout/page.tsx",
          status: "renamed",
          previousPath: "src/pay/page.tsx",
        }),
      ]),
    ).toEqual(["src/checkout/page.tsx", "src/pay/page.tsx"]);
  });

  it("drops a path that normalises to nothing", () => {
    expect(changedPaths([file({ path: "/" }), file({ path: "a.ts" })])).toEqual([
      "a.ts",
    ]);
  });

  it("has nothing to say about a commit with no files", () => {
    expect(changedPaths([])).toEqual([]);
  });
});

describe("splitMessage", () => {
  it("takes the first line as the title and the rest as the body", () => {
    expect(splitMessage("결제를 고쳤어요\n\n버튼이 두 번 눌리던 문제예요.")).toEqual({
      title: "결제를 고쳤어요",
      body: "버튼이 두 번 눌리던 문제예요.",
    });
  });

  it("leaves the body null when there is only a title", () => {
    expect(splitMessage("첫 커밋")).toEqual({ title: "첫 커밋", body: null });
  });

  it("says so rather than leaving an empty row", () => {
    // A commit with an empty message is legal, and a blank row in a list reads
    // as something that failed to load rather than as something that is so.
    expect(splitMessage("   \n\n  ").title).toBe("(메시지가 없어요)");
  });

  it("shortens a title rather than letting it run, and shows that it did", () => {
    const long = "가".repeat(400);
    const { title } = splitMessage(long);
    expect(title).toHaveLength(200);
    expect(title.endsWith("…")).toBe(true);
  });
});
