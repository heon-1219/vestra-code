/**
 * Reading the answer stream, one frame at a time.
 *
 * The analysis stream is a GET and the browser's own `EventSource` handles it,
 * including the reconnect and the `Last-Event-ID` replay that
 * `use-analysis-stream.ts` leans on. Asking a question is a POST — it carries
 * the question, the chosen model and the effort — and `EventSource` cannot send
 * a body. So this half is read by hand.
 *
 * What that costs is exactly this file: the framing `EventSource` would have
 * done. It is kept separate from the fetch so it can be tested without a
 * network, which matters more here than it looks, because every real failure of
 * a hand-rolled SSE reader is a **chunk boundary** failure and those are
 * precisely what a live test will not reproduce. A reader that works against a
 * fast local server and breaks on a slow connection is the normal outcome, not
 * an unlucky one: the network decides where the splits land, and it splits
 * differently every time.
 *
 * Deliberately NOT here: reconnection. A half-finished investigation cannot be
 * resumed — the loop holds its ledger and its budget in memory and a second
 * request would start a new one, spending the person's tokens again to answer a
 * question they already half-watched. When this stream drops, the honest move
 * is to say so and offer to ask again, which is the caller's decision to make.
 */

export type AskFrame = {
  /** The server's sequence number. Monotonic, and gaps mean frames were lost. */
  seq: number;
  type: string;
  /** Parsed from the frame's `data`. `unknown` because the wire decides. */
  payload: unknown;
};

export type FrameReader = {
  /**
   * Hand it whatever just arrived. Returns the frames that are now complete;
   * a partial frame is held until the rest of it turns up.
   */
  push(chunk: string): AskFrame[];
  /**
   * Whatever is left when the stream ends.
   *
   * A well-behaved server ends on a blank line and this returns nothing. It
   * exists for the server that does not, because a final frame dropped in
   * silence is an answer that never arrives on screen.
   */
  flush(): AskFrame[];
};

export function createFrameReader(): FrameReader {
  let buffer = "";

  function take(raw: string): AskFrame | null {
    const block = raw.trim();
    if (block.length === 0) return null;

    let seq: number | null = null;
    let type: string | null = null;
    const data: string[] = [];

    for (const line of block.split("\n")) {
      // A comment, which is what a keepalive is. Arrives on a timer during a
      // long step and must not be mistaken for an empty event.
      if (line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const field = line.slice(0, colon);
      // One optional space after the colon, per the format. Only one: a
      // `data` line whose payload legitimately begins with a space would
      // otherwise arrive trimmed.
      const value = line.slice(line[colon + 1] === " " ? colon + 2 : colon + 1);

      if (field === "id") {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) seq = parsed;
      } else if (field === "event") {
        type = value;
      } else if (field === "data") {
        data.push(value);
      }
    }

    if (type === null || data.length === 0) return null;

    let payload: unknown;
    try {
      // Rejoined with newlines, which is how a multi-line `data` is defined.
      // Our own frames are single-line JSON today; a payload that ever grows a
      // newline must not silently become a parse failure.
      payload = JSON.parse(data.join("\n"));
    } catch {
      /*
       * A frame we cannot read is dropped, not thrown.
       *
       * Killing the stream over one bad frame would throw away the steps
       * already on screen and the answer still coming. The gap shows up in the
       * sequence numbers, which is where a caller can notice it.
       */
      return null;
    }

    return { seq: seq ?? 0, type, payload };
  }

  return {
    push(chunk) {
      // Normalised first: a proxy or a runtime may rewrite line endings, and a
      // frame split on "\n\n" would then never match.
      buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      const frames: AskFrame[] = [];
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const frame = take(buffer.slice(0, split));
        if (frame) frames.push(frame);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
      return frames;
    },

    flush() {
      const rest = buffer;
      buffer = "";
      const frame = take(rest);
      return frame ? [frame] : [];
    },
  };
}
