import { z } from "zod";

import type { NodeRef } from "@/analysis/ids";
import type { AnalyzedEdge } from "@/analysis/types";
// `@/lib/llm/types` rather than the package index, and the distinction is
// load-bearing: the index re-exports `llmFromEnv`, which pulls in `env.ts` — and
// `env.ts` validates every variable the moment it is imported and throws when
// one is missing. `LlmError` is a class, so importing it is a runtime import;
// taken from the index it would make this module, and every test of it,
// unimportable on a machine with no API key.
import { LlmError, type Llm } from "@/lib/llm/types";

/**
 * The half of the Python analyzer a model produces, and the rules that keep it
 * from being fiction.
 *
 * A Python call cannot be resolved by reading paths. `place_order(...)` might
 * be the imported function, a method on a local object, a name rebound three
 * lines up, or something a decorator installed — and the analyzer has no type
 * information with which to tell those apart. So calls come from a model, and
 * **everything this module produces is `inferred`**, marked as the model's, with
 * no exception for however confident the model sounds.
 *
 * ## The one rule that makes this safe
 *
 * The model may not invent a target. It is handed the symbols that exist, it
 * answers with an index into that list and a line number, and then every answer
 * is checked against the file that is sitting right here:
 *
 *   1. the index has to be in range — a name it made up has no index;
 *   2. the line has to be one we actually sent it;
 *   3. the line has to be inside the body of the symbol it says is calling;
 *   4. **the target's name has to appear on that line of the stripped source.**
 *
 * The fourth is the one that matters. A model that is reasoning loosely about a
 * file produces plausible calls that are not there, and the first three checks
 * all pass for a plausible call. Matching the name against the real line makes
 * the claim checkable by the same evidence a person would use.
 *
 * Anything that fails is **dropped, not downgraded**. There is no lower
 * confidence to fall to: the product has two values and the user cannot open
 * the code to check either. A fabricated line on a map that nobody can audit is
 * the worst thing this product can do.
 */

export type PythonSymbol = {
  ref: NodeRef;
  name: string;
  container?: string;
  startLine: number;
  endLine: number;
  kind: "function" | "class";
};

export type PythonFileFacts = {
  path: string;
  /** The file's text, read once by the caller. */
  source: string;
  /** Per physical line, code only: comments gone, string contents emptied. */
  code: string[];
  /** Symbols declared in this file. */
  symbols: PythonSymbol[];
  /** Files this file imports, from the parser's own certain edges. */
  importedPaths: string[];
  /** A local name bound by `as`, mapped to the project name it stands for. */
  aliases: Map<string, string>;
  /** How many files import this one. Used only to decide what to look at first. */
  importedBy: number;
};

/**
 * What this pass may spend. D52-D54 exist because tokens on a 300-file repo are
 * the expensive part of the whole product, and none of these numbers is a
 * guess about model quality — each is a ceiling on cost.
 */
export type PythonLlmBudget = {
  /** How many files the model is shown at all. The rest are reported, not examined. */
  maxFiles: number;
  /** Characters of one file. Past this the tail is cut and the model is told so. */
  maxFileChars: number;
  /** Candidate targets listed for one file. */
  maxCandidates: number;
  /** Input plus output tokens for the whole pass. */
  maxTokens: number;
  /** Ceiling on one reply, so a runaway answer cannot eat the budget alone. */
  maxOutputTokens: number;
};

export const DEFAULT_PYTHON_LLM_BUDGET: PythonLlmBudget = {
  // 40 files at roughly 4k tokens of source each is about 160k input tokens —
  // the same order as D52's Pass 2 outline, for a pass that reads real code.
  maxFiles: 40,
  maxFileChars: 12_000,
  // Past this the candidate list costs more than the file itself, and a list a
  // model cannot hold in view is one it picks from carelessly.
  maxCandidates: 120,
  maxTokens: 300_000,
  maxOutputTokens: 1_500,
};

/** Why a claim was thrown away. Counted, so a bad prompt shows up as a number. */
export type DropReason =
  | "unknown_source"
  | "unknown_target"
  | "self_call"
  | "line_not_sent"
  | "line_outside_source"
  | "name_not_on_line"
  | "undeclared";

export type PythonLlmResult = {
  edges: AnalyzedEdge[];
  /** One short sentence about what a thing is for, to sit on the node. */
  roles: { ref: NodeRef; role: string }[];
  /** Files the model actually read. */
  examined: string[];
  /**
   * Files it did not. **"We did not look" and "there is nothing there" are
   * opposite claims**, and the caller has to be able to say which one happened.
   */
  notExamined: string[];
  /** Why the pass stopped, when it stopped early. */
  stopped: "completed" | "token_budget" | "file_budget" | "llm_error" | "aborted";
  /** The failure that stopped it, in Korean, when one did. */
  error: string | null;
  spent: { calls: number; inputTokens: number; outputTokens: number };
  dropped: Record<DropReason, number>;
};

/**
 * Words a model reaches for and the product does not allow.
 *
 * The same three as the Q&A loop's `FORBIDDEN_WORDS`, deliberately re-stated
 * here rather than imported: `src/qa/answer.ts` reaches `src/qa/tools.ts`,
 * which imports the workspace map components, and an analyzer that pulled a
 * React component tree into itself could no longer be run from a plain test —
 * which is the one property the Analyzer signature exists to protect. If a
 * fourth word is ever added, it belongs in both places.
 *
 * `안전` because the product may never tell someone a change is safe. `노드` and
 * `엣지` because past `lib/graph/view.ts` a thing is a 조각 and a link is a 연결,
 * and a model handed a graph reaches for the graph's words.
 */
const FORBIDDEN_WORDS = ["안전", "노드", "엣지"] as const;

const integer = z.coerce.number().int();

const replySchema = z.object({
  calls: z
    .array(
      z.object({
        from: integer.min(0),
        to: integer.min(0),
        line: integer.min(1),
      }),
    )
    .max(300)
    .optional(),
  roles: z
    .array(z.object({ symbol: integer.min(0), role: z.string().trim().min(1).max(80) }))
    .max(200)
    .optional(),
  fileRole: z.string().trim().min(1).max(120).optional(),
});

/** The shape sent as `json_schema`, honoured only where the endpoint has it (D47). */
const REPLY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    calls: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "integer" },
          to: { type: "integer" },
          line: { type: "integer" },
        },
        required: ["from", "to", "line"],
      },
    },
    roles: {
      type: "array",
      items: {
        type: "object",
        properties: { symbol: { type: "integer" }, role: { type: "string" } },
        required: ["symbol", "role"],
      },
    },
    fileRole: { type: "string" },
  },
  required: ["calls"],
};

const SYSTEM_PROMPT = [
  "당신은 파이썬 파일 하나를 읽고, 그 안에서 실제로 일어나는 호출만 골라내는 읽는 사람이에요.",
  "",
  "지켜야 할 것.",
  "1. 목록에 있는 번호만 답해요. 목록에 없는 이름은 적지 마세요. 없으면 그냥 빼요.",
  "2. 줄 번호는 보내드린 소스에 실제로 있는 줄이어야 해요. 그 줄에 그 이름이 그대로 적혀 있어야 해요.",
  "3. 호출하는 쪽은 그 줄을 품고 있는 조각이어야 해요. 다른 조각의 줄을 가져다 쓰지 마세요.",
  "4. 확실하지 않으면 적지 마세요. 빠뜨린 건 나중에 채울 수 있지만, 없는 연결은 사람이 확인할 방법이 없어요.",
  "5. role은 한국어 해요체 한 문장으로, 코드를 모르는 사람이 읽을 수 있게 짧게 써요. '안전', '노드', '엣지'라는 말은 쓰지 마세요.",
  "",
  "JSON만 답해요. 설명은 넣지 마세요.",
  '{"calls":[{"from":0,"to":3,"line":42}],"roles":[{"symbol":0,"role":"주문을 넣어요"}],"fileRole":"주문을 처리하는 곳이에요"}',
].join("\n");

export async function runPythonLlmPass(input: {
  llm: Llm;
  files: readonly PythonFileFacts[];
  /** Every symbol in the project, by the file that declares it. */
  symbolsByFile: ReadonlyMap<string, PythonSymbol[]>;
  /** Whether the caller made a node for this ref. Nothing points at what is not there. */
  declared: (ref: NodeRef) => boolean;
  budget?: Partial<PythonLlmBudget>;
  signal?: AbortSignal;
}): Promise<PythonLlmResult> {
  const budget = { ...DEFAULT_PYTHON_LLM_BUDGET, ...input.budget };

  const result: PythonLlmResult = {
    edges: [],
    roles: [],
    examined: [],
    notExamined: [],
    stopped: "completed",
    error: null,
    spent: { calls: 0, inputTokens: 0, outputTokens: 0 },
    dropped: {
      unknown_source: 0,
      unknown_target: 0,
      self_call: 0,
      line_not_sent: 0,
      line_outside_source: 0,
      name_not_on_line: 0,
      undeclared: 0,
    },
  };

  const ordered = rankFiles(input.files);
  const chosen = ordered.slice(0, budget.maxFiles);
  const skipped = ordered.slice(budget.maxFiles);
  result.notExamined = skipped.map((file) => file.path);
  if (skipped.length > 0) result.stopped = "file_budget";

  for (const file of chosen) {
    if (input.signal?.aborted) {
      result.stopped = "aborted";
      break;
    }
    if (spentTokens(result) >= budget.maxTokens) {
      // Out of budget, not out of files. Everything from here on is a file we
      // did not look at, and saying so is the whole point of the distinction.
      result.stopped = "token_budget";
      result.notExamined.push(...remaining(chosen, file));
      break;
    }

    const prompt = buildFilePrompt(file, input.symbolsByFile, budget);
    if (prompt === null) {
      // Nothing in this file can call anything we know about. A question with
      // no possible answer is a question not worth its tokens.
      result.examined.push(file.path);
      continue;
    }

    let reply;
    try {
      reply = await input.llm.complete({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt.text },
        ],
        maxOutputTokens: budget.maxOutputTokens,
        temperature: 0,
        jsonSchema: { name: "python_calls", schema: REPLY_JSON_SCHEMA },
        effort: "fast",
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      /*
       * One file's failure is not the run's failure — unless retrying cannot
       * help. A wrong key will still be wrong on the fortieth file, and forty
       * requests spent discovering that is the user's time.
       */
      const fatal = !(error instanceof LlmError) || !error.retryable;
      result.error = describeFailure(error);
      if (fatal) {
        result.stopped = error instanceof LlmError && error.kind === "aborted"
          ? "aborted"
          : "llm_error";
        result.notExamined.push(...remaining(chosen, file));
        break;
      }
      result.notExamined.push(file.path);
      continue;
    }

    result.spent.calls += 1;
    result.spent.inputTokens += reply.usage.inputTokens;
    result.spent.outputTokens += reply.usage.outputTokens;
    result.examined.push(file.path);

    // A truncated reply is not a reply. Half a JSON object parses to nothing
    // useful anyway, and treating what did parse as complete would silently
    // keep the first few calls and lose the rest without saying so.
    if (reply.finishReason === "length") continue;

    const answer = parseReply(reply.text);
    if (!answer) continue;

    collect(answer, file, prompt, input.declared, result);
  }

  return result;
}

// ---------------------------------------------------------------------------

type FilePrompt = {
  text: string;
  /** Index 0..ownCount-1 are this file's own symbols and may be a call's source. */
  candidates: PythonSymbol[];
  ownCount: number;
  /** The last source line the model was actually shown. */
  lastLineSent: number;
};

/**
 * Which files get looked at when there are more than the budget allows.
 *
 * Most-imported first, then most symbols. A file everything else imports is
 * where a person points when they ask what their project does, and it is also
 * the file whose missing connections are most visible on the map. Ties break on
 * the path so two runs over an unchanged repository ask the same questions in
 * the same order — which is what any later cache on this pass will depend on.
 */
function rankFiles(files: readonly PythonFileFacts[]): PythonFileFacts[] {
  return [...files].sort(
    (a, b) =>
      b.importedBy - a.importedBy ||
      b.symbols.length - a.symbols.length ||
      a.path.localeCompare(b.path),
  );
}

function remaining(
  ordered: readonly PythonFileFacts[],
  from: PythonFileFacts,
): string[] {
  const at = ordered.indexOf(from);
  return at === -1 ? [] : ordered.slice(at).map((file) => file.path);
}

function spentTokens(result: PythonLlmResult): number {
  return result.spent.inputTokens + result.spent.outputTokens;
}

/**
 * What the model is shown for one file: the symbols it may name, and the source.
 *
 * The candidate list is **this file's own symbols plus the symbols of the files
 * it imports**, and not every symbol in the project. Two reasons, and the
 * second is the one that would be easy to lose:
 *
 *   - Cost. A 300-file repository has thousands of symbols and the list would
 *     be re-sent with every file, dwarfing the source it is supposed to help
 *     read (D52 measured the same effect on Pass 2's outline).
 *   - Truth. Python can only call what the module imported or declared itself.
 *     A list containing names this file has no way to reach is a list of
 *     invitations to be wrong, and every one of those wrong answers would then
 *     have to be caught downstream.
 */
function buildFilePrompt(
  file: PythonFileFacts,
  symbolsByFile: ReadonlyMap<string, PythonSymbol[]>,
  budget: PythonLlmBudget,
): FilePrompt | null {
  const candidates: PythonSymbol[] = [...file.symbols];
  const ownCount = candidates.length;
  if (ownCount === 0) return null;

  for (const imported of file.importedPaths) {
    for (const symbol of symbolsByFile.get(imported) ?? []) {
      if (candidates.length >= budget.maxCandidates) break;
      candidates.push(symbol);
    }
  }

  const lines = file.source.split(/\r?\n/);
  const numbered: string[] = [];
  let characters = 0;
  let lastLineSent = 0;

  for (let index = 0; index < lines.length; index++) {
    const rendered = `${index + 1}: ${lines[index]}`;
    if (characters + rendered.length > budget.maxFileChars) break;
    characters += rendered.length + 1;
    numbered.push(rendered);
    lastLineSent = index + 1;
  }

  const cut = lines.length - lastLineSent;

  const listed = candidates
    .map((symbol, index) => `${index}. ${describe(symbol, index < ownCount)}`)
    .join("\n");

  const text = [
    `파일: ${file.path}`,
    "",
    "이 파일이 부를 수 있는 것들이에요. 번호로 답해요.",
    listed,
    "",
    `0번부터 ${ownCount - 1}번까지가 이 파일 안에 있는 조각이고, calls의 from은 이 중에서 골라요.`,
    "",
    "소스예요. 앞의 숫자가 줄 번호예요.",
    numbered.join("\n"),
    cut > 0 ? `… 아래 ${cut}줄은 보내지 않았어요. 이 부분은 답하지 마세요.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { text, candidates, ownCount, lastLineSent };
}

function describe(symbol: PythonSymbol, own: boolean): string {
  const name = symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
  const where = own ? `${symbol.startLine}-${symbol.endLine}줄` : symbol.ref.filePath;
  return `${name} (${symbol.kind === "class" ? "클래스" : "함수"}, ${where})`;
}

/**
 * The model's JSON, however it wrapped it.
 *
 * Only the endpoints that advertise `json_schema` are held to it on the wire
 * (D47), so on the others the reply arrives as prose around an object, or
 * inside a fenced block. Returning null on anything unparseable is the whole of
 * the error handling this needs: a reply we cannot read produces no edges,
 * which is the correct outcome.
 */
function parseReply(text: string | null): z.infer<typeof replySchema> | null {
  if (!text) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let json: unknown;
  try {
    json = JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }

  const parsed = replySchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function collect(
  answer: z.infer<typeof replySchema>,
  file: PythonFileFacts,
  prompt: FilePrompt,
  declared: (ref: NodeRef) => boolean,
  result: PythonLlmResult,
): void {
  const seen = new Set<string>();

  for (const claim of answer.calls ?? []) {
    const source = prompt.candidates[claim.from];
    const target = prompt.candidates[claim.to];

    if (!source || claim.from >= prompt.ownCount) {
      result.dropped.unknown_source += 1;
      continue;
    }
    if (!target) {
      result.dropped.unknown_target += 1;
      continue;
    }
    if (claim.from === claim.to) {
      // A function calling itself is usually the model attributing a definition
      // to itself rather than recursion, and a self-loop is the highest-weight
      // edge on the map for a fact nobody asked about (D32).
      result.dropped.self_call += 1;
      continue;
    }
    if (claim.line > prompt.lastLineSent) {
      result.dropped.line_not_sent += 1;
      continue;
    }
    if (claim.line < source.startLine || claim.line > source.endLine) {
      // The claim contradicts itself: this line is not in the body of the thing
      // it says is doing the calling.
      result.dropped.line_outside_source += 1;
      continue;
    }
    if (!namedOnLine(file, target, claim.line)) {
      result.dropped.name_not_on_line += 1;
      continue;
    }
    if (!declared(source.ref) || !declared(target.ref)) {
      result.dropped.undeclared += 1;
      continue;
    }

    const key = JSON.stringify([source.ref, target.ref]);
    if (seen.has(key)) continue;
    seen.add(key);

    result.edges.push({
      source: source.ref,
      target: target.ref,
      type: "calls",
      confidence: "inferred",
      metadata: {
        line: claim.line,
        // Carried on every edge this pass makes, so that a graph can always be
        // asked which half of it a model produced — and so the pipeline can
        // write these rows with `origin: "llm"` rather than `static`.
        origin: "llm",
        via: "python-llm",
      },
    });
  }

  for (const claim of answer.roles ?? []) {
    const symbol = prompt.candidates[claim.symbol];
    if (!symbol || claim.symbol >= prompt.ownCount) continue;
    const role = cleanRole(claim.role);
    if (!role || !declared(symbol.ref)) continue;
    result.roles.push({ ref: symbol.ref, role });
  }

  const fileRole = cleanRole(answer.fileRole ?? "");
  if (fileRole) {
    result.roles.push({ ref: { type: "file", filePath: file.path }, role: fileRole });
  }
}

/**
 * Whether the target's name is actually written on the line that was claimed.
 *
 * Checked against the stripped source, so a mention inside a comment or a
 * docstring does not count as a call — which is precisely the sentence a model
 * is most likely to have been reading when it invented one.
 *
 * Aliases are accepted because `from broker import place_order as po` makes
 * `po(...)` the real spelling of a real call, and refusing it would drop a true
 * edge over a rename. Nothing else is accepted: a call spelled some other way
 * is dropped rather than downgraded.
 *
 * A qualified call counts. `orders.place_order(...)`, `self.place(...)` and
 * `broker.place_order(...)` all write the name on the line, and this is how
 * most of Python's calls are actually written — a check that demanded a bare
 * name would throw away nearly every method call and every call through an
 * imported module, which is most of what there is to find.
 */
function namedOnLine(file: PythonFileFacts, target: PythonSymbol, line: number): boolean {
  const text = file.code[line - 1];
  if (!text) return false;

  const spellings = new Set<string>([target.name]);
  for (const [local, original] of file.aliases) {
    if (original === target.name) spellings.add(local);
  }

  // Word-bounded at both ends, so `order` matches neither `reorder_items` nor
  // `order_total` — a substring match would accept almost any line.
  return [...spellings].some((spelling) =>
    new RegExp(`(?<!\\w)${escapeRegExp(spelling)}\\b`).test(text),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanRole(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (FORBIDDEN_WORDS.some((word) => text.includes(word))) return null;
  return text;
}

function describeFailure(error: unknown): string {
  if (error instanceof LlmError) {
    if (error.kind === "auth") return "모델 열쇠가 맞지 않아서 더 살펴보지 못했어요.";
    if (error.kind === "rate_limit") return "모델이 잠시 바빠서 일부는 살펴보지 못했어요.";
    if (error.kind === "aborted") return "분석이 중간에 멈춰서 일부는 살펴보지 못했어요.";
    return "모델에 물어보다가 문제가 생겨서 일부는 살펴보지 못했어요.";
  }
  return "모델에 물어보다가 문제가 생겨서 일부는 살펴보지 못했어요.";
}
