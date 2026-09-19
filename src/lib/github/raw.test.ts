import { describe, expect, it, vi } from "vitest";

import { buildRawUrl, fetchRawFile, RAW_MESSAGES } from "./raw";

/**
 * A body that records whether anyone let it go.
 *
 * An unread response body holds a socket open until the runtime gives up on it,
 * so every path that decides not to read one has to cancel it.
 */
function watchedBody(bytes = 2): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  return Buffer.concat(parts.map((part) => Buffer.from(part))).toString("utf8");
}

const BASE = {
  owner: "heon-1219",
  repo: "coding-interview-prep",
  ref: "9f2a1c0d9f2a1c0d9f2a1c0d9f2a1c0d9f2a1c0d",
  path: "src/app/page.js",
  token: null,
  maxBytes: 512 * 1024,
};

describe("buildRawUrl", () => {
  it("asks the contents endpoint at one exact commit", () => {
    expect(buildRawUrl("heon-1219", "prep", "abc123", "src/app/page.js")).toBe(
      "https://api.github.com/repos/heon-1219/prep/contents/src/app/page.js?ref=abc123",
    );
  });

  it("encodes each segment and leaves the separators alone", () => {
    // encodeURIComponent on the whole path would escape the slashes too, and
    // GitHub would look for one file with slashes in its name.
    expect(buildRawUrl("o", "r", "main", "공개/사 진.png")).toBe(
      "https://api.github.com/repos/o/r/contents/%EA%B3%B5%EA%B0%9C/%EC%82%AC%20%EC%A7%84.png?ref=main",
    );
  });

  it("encodes a branch name that contains a slash", () => {
    expect(buildRawUrl("o", "r", "feat/preview", "a.ts")).toContain("?ref=feat%2Fpreview");
  });
});

describe("fetchRawFile", () => {
  it("asks for the file itself, and says who is asking when it can", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(bodyOf([new TextEncoder().encode("export default 1;\n")]), {
        status: 200,
        headers: { "content-length": "18" },
      }),
    );

    const result = await fetchRawFile({ ...BASE, token: "gho_abc", fetchImpl });

    expect(result.ok).toBe(true);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github.raw+json");
    expect(headers.Authorization).toBe("Bearer gho_abc");
    // Nothing about someone's source may be held between them and GitHub.
    expect(init.cache).toBe("no-store");
  });

  it("works without a token, because a public repository needs none", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(bodyOf([new TextEncoder().encode("hi")]), {
        status: 200,
        headers: { "content-length": "2" },
      }),
    );

    await fetchRawFile({ ...BASE, fetchImpl });

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("hands back a stream, not a string", async () => {
    const result = await fetchRawFile({
      ...BASE,
      fetchImpl: async () =>
        new Response(bodyOf([new TextEncoder().encode("line one\nline two\n")]), {
          status: 200,
          headers: { "content-length": "18" },
        }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toBeInstanceOf(ReadableStream);
    expect(result.value.size).toBe(18);
    expect(await collect(result.value.body)).toBe("line one\nline two\n");
  });

  it("refuses from the declared length, before the body is read", async () => {
    // The body here is two bytes and the head says four megabytes. If the
    // ceiling were measured by reading, this file would sail through. It does
    // not — which is the property that matters: we decide from the head, so we
    // never move the thing we are refusing to move.
    const body = watchedBody(2);
    const result = await fetchRawFile({
      ...BASE,
      maxBytes: 1024,
      fetchImpl: async () =>
        new Response(body.stream, {
          status: 200,
          headers: { "content-length": String(4 * 1024 * 1024) },
        }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("too_large");
    expect(result.size).toBe(4 * 1024 * 1024);
    // And we let the socket go rather than leaving GitHub streaming into
    // nothing.
    expect(body.cancelled()).toBe(true);
  });

  it("takes a file exactly on the ceiling", async () => {
    const result = await fetchRawFile({
      ...BASE,
      maxBytes: 1024,
      fetchImpl: async () =>
        new Response(bodyOf([new Uint8Array(1024)]), {
          status: 200,
          headers: { "content-length": "1024" },
        }),
    });
    expect(result.ok).toBe(true);
  });

  it("still stops a body that runs past the ceiling when GitHub declared no length", async () => {
    // The backstop. It cannot un-send the head, so this is a broken transfer
    // rather than a refusal — which is the right failure: a silently truncated
    // file that someone reads as the whole thing is the worse outcome.
    const result = await fetchRawFile({
      ...BASE,
      maxBytes: 8,
      fetchImpl: async () =>
        new Response(bodyOf([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)]), {
          status: 200,
        }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.size).toBeNull();
    await expect(collect(result.value.body)).rejects.toThrow();
  });

  it("lets a short body through when GitHub declared no length", async () => {
    const result = await fetchRawFile({
      ...BASE,
      maxBytes: 64,
      fetchImpl: async () =>
        new Response(bodyOf([new TextEncoder().encode("ok")]), { status: 200 }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await collect(result.value.body)).toBe("ok");
  });

  it("reads an empty file as an answer rather than a failure", async () => {
    const result = await fetchRawFile({
      ...BASE,
      fetchImpl: async () => new Response(null, { status: 200, headers: { "content-length": "0" } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await collect(result.value.body)).toBe("");
  });

  it("maps every way GitHub says no to something we can say out loud", async () => {
    const cases: Array<[number, string]> = [
      [404, "not_found"],
      [403, "rate_limited"],
      [429, "rate_limited"],
      [451, "unavailable"],
      [500, "unavailable"],
    ];

    for (const [status, expected] of cases) {
      const body = watchedBody();
      const result = await fetchRawFile({
        ...BASE,
        fetchImpl: async () => new Response(body.stream, { status }),
      });
      expect(result.ok, String(status)).toBe(false);
      if (result.ok) continue;
      expect(result.error, String(status)).toBe(expected);
      expect(result.status).toBe(status);
      // A failure body nobody is going to read holds a socket open.
      expect(body.cancelled(), String(status)).toBe(true);
    }
  });

  it("treats a network that is not there as something to try again later", async () => {
    const result = await fetchRawFile({
      ...BASE,
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("unavailable");
  });

  it("has a sentence for every failure it can return", () => {
    for (const key of [
      "not_found",
      "private",
      "rate_limited",
      "unavailable",
      "empty_repo",
      "malformed",
      "too_large",
    ] as const) {
      expect(RAW_MESSAGES[key].length, key).toBeGreaterThan(0);
    }
  });

  it("never tells someone their own project is unsafe or broken", () => {
    // Section 3: the word 안전 is not ours to use, and neither is blame.
    for (const message of Object.values(RAW_MESSAGES)) {
      expect(message).not.toContain("안전");
      expect(message).not.toMatch(/노드|엣지/);
    }
  });
});
