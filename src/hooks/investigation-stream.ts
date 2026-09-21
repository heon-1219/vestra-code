import { createFrameReader, type AskFrame } from "@/lib/ask/frames";

/**
 * One POST whose answer is a stream of investigation frames, read to the end.
 *
 * `/ask` and `/explain` answer in exactly the same frames — both run
 * `investigate()` and both send through `lib/ask/stream.ts` — so reading them
 * is one function rather than two copies that could come to disagree about a
 * chunk boundary. What stays in each hook is what differs: the URL, the body,
 * and what the screen does with the result.
 *
 * Three outcomes, and the caller has to handle each:
 *
 *   - **Refused**: the route answered with a status and, usually, a sentence
 *     written for this person — no model, no stored files, not your project.
 *     That sentence is returned as-is, because it is the one thing that tells
 *     them what to do next.
 *   - **Streamed**: every complete frame went to `onFrame`, in order, and the
 *     stream ended. Whether it ended *with an answer* is the caller's to judge.
 *   - **Thrown**: the network failed or the request was aborted. The caller
 *     checks its own signal to tell the two apart.
 */
export async function streamInvestigation(options: {
  url: string;
  body: unknown;
  signal: AbortSignal;
  onFrame: (frame: AskFrame) => void;
}): Promise<{ refused: string | null } | null> {
  const response = await fetch(options.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const said = await response
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "message" in body
          ? String((body as { message: unknown }).message)
          : null,
      )
      .catch(() => null);
    return { refused: said };
  }

  const reader = response.body.getReader();
  /*
   * `stream: true` is not optional here.
   *
   * A Korean character is three bytes and a chunk boundary lands in the middle
   * of one regularly. Decoding each chunk independently turns that into a
   * replacement character in the middle of a sentence the person is reading —
   * the kind of fault that only shows up over a real connection, and only
   * sometimes.
   */
  const decoder = new TextDecoder("utf-8");
  const frames = createFrameReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of frames.push(decoder.decode(value, { stream: true }))) {
      options.onFrame(frame);
    }
  }
  for (const frame of frames.flush()) options.onFrame(frame);
  return null;
}
