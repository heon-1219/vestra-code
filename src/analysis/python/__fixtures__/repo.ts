import type {
  AnalysisEmitter,
  AnalyzedEdge,
  AnalyzedNode,
  SourceFile,
} from "@/analysis/types";
import type { Llm, LlmReply, LlmRequest } from "@/lib/llm/types";

/**
 * A Python repository that exists only in memory, and a model that says
 * exactly what the test tells it to.
 *
 * The Python analyzer is pure over (files, root, emit) and never touches the
 * filesystem — unlike the TypeScript one, which has to materialise a real tree
 * because ts-morph resolves through the disk. Nothing here needs a temp
 * directory, a tarball or a database, so a fixture repository is four lines and
 * a test can state the exact tree that produces the behaviour it is about.
 */

/** `null` content means a binary asset, which ingest offers but never reads. */
export function tree(entries: Record<string, string | null>): SourceFile[] {
  return Object.entries(entries).map(([path, content]) => ({
    path,
    absolutePath: `/repo/${path}`,
    size: content === null ? 2048 : Buffer.byteLength(content, "utf8"),
    read: content === null ? null : () => content,
  }));
}

export type Recorded = {
  nodes: AnalyzedNode[];
  edges: AnalyzedEdge[];
  phases: string[];
  parsed: string[];
  skipped: { path: string; reason: string }[];
  emit: AnalysisEmitter;
};

export function recorder(): Recorded {
  const record: Recorded = {
    nodes: [],
    edges: [],
    phases: [],
    parsed: [],
    skipped: [],
    emit: {
      phase: (phase) => void record.phases.push(phase),
      fileParsed: (path) => void record.parsed.push(path),
      nodes: (nodes) => void record.nodes.push(...nodes),
      edges: (edges) => void record.edges.push(...edges),
      fileSkipped: (path, reason) => void record.skipped.push({ path, reason }),
    },
  };
  return record;
}

/** A reply that is only JSON, which is what this pass asks for. */
export function replyJson(body: unknown, extra: Partial<LlmReply> = {}): LlmReply {
  return {
    text: JSON.stringify(body),
    toolCalls: [],
    usage: { inputTokens: 500, outputTokens: 120 },
    finishReason: "stop",
    ...extra,
  };
}

export type Scripted = LlmReply | (() => LlmReply);

/**
 * A model that returns a fixed sequence and records what it was asked.
 *
 * There is no API key on this machine and there should not need to be — that is
 * what `Llm` being injected buys. Running off the end of the script throws
 * rather than looping, because a pass that asked more questions than the test
 * scripted is exactly the budget bug these tests exist to catch.
 */
export function scriptedLlm(script: readonly Scripted[]): {
  llm: Llm;
  requests: LlmRequest[];
} {
  const requests: LlmRequest[] = [];
  let at = 0;
  const llm: Llm = {
    complete(request) {
      requests.push(request);
      if (at >= script.length) {
        throw new Error(`대본에 없는 ${at + 1}번째 호출이에요.`);
      }
      const next = script[at];
      at += 1;
      return Promise.resolve(typeof next === "function" ? next() : next);
    },
  };
  return { llm, requests };
}
