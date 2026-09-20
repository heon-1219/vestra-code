"use client";

import {
  branchesNote,
  flowRefusalSentence,
  FLOW_NOTICE,
  type FlowGraph,
  type FlowHop,
  type FlowPath,
} from "@/lib/graph/flow";
import type { Description } from "@/lib/graph/describe";
import {
  CERTAINTY_WORDS,
  KIND_WORDS,
  type Certainty,
  type GraphItem,
} from "@/lib/graph/view";

import { flowNotes } from "../flow/notes";
import { PlayerControls } from "../flow/player-controls";
import {
  GUESSED_START_NOTE,
  startCertainty,
  weaker,
  type FlowChoice,
} from "../flow/start";
import type { FlowControls } from "../flow/use-flow";
import {
  CertaintyMark,
  displayName,
  ModelMark,
  MODEL_TAG,
  MODEL_WROTE_IT,
} from "./connection-row";
import { PanelHeading } from "./states";

/**
 * 흐름 따라가기, as the panel shows it.
 *
 * Its own file rather than a fifth state inside `states.tsx`, which
 * `FLOW_TRACKING.md` §11.8 asked for and which is still right: this is the only
 * panel state with a control in it, and it would be the longest thing in a file
 * that is otherwise a list of short ones.
 *
 * ## What the screen is not allowed to say
 *
 * Every sentence a reader sees here is either written by `lib/graph/flow.ts` —
 * the hop lines, the five terminals, the refusals, the notes — or is one of the
 * handful written in this file and checked by the same `flowSentenceIssues` in
 * `flow-state.test.ts`. 실행 · 추적 · 실시간 · 안전 · 노드 · 엣지 appear in none of
 * them. The feature is 흐름 따라가기 and never 추적, and no step is phrased in the
 * past tense of something having run, because nothing ran.
 *
 * `FLOW_NOTICE` sits at the top and is not collapsible. It is the sentence that
 * says we did not open anybody's app, and a sentence behind a disclosure
 * triangle is a sentence most people never read.
 *
 * ## Why the terminal is held back
 *
 * The path is finished before the first step is drawn, so the panel *has* the
 * ending the whole time. It prints it only when the reader arrives: "여기가
 * 끝이에요" beside step 2 of 7 is not a spoiler so much as a contradiction, and
 * the same goes for the whole-flow notes. The row list is the same way — a
 * greyed row for a step not yet reached would be the shape of a placeholder,
 * and §5's table is explicit that a row never shows one.
 */

export function FlowState({
  flow,
  graph,
  itemsById,
  described,
  importCount,
  onOpen,
  onStart,
}: {
  flow: FlowControls;
  /**
   * The graph itself, for the one question the walk does not ask: how sure we
   * are that the **address we started from** is there at all.
   */
  graph: FlowGraph;
  itemsById: ReadonlyMap<string, GraphItem>;
  described: ReadonlyMap<string, Description>;
  /** How many `imports` the project has, for §7's shallow-analyzer sentence. */
  importCount: number;
  onOpen?: (id: string) => void;
  /** Start again somewhere else. The refusals all end by offering this. */
  onStart: (itemId: string) => void;
}) {
  const { session } = flow;
  if (!session) return null;

  const trace = session.trace;
  const start = trace?.start ?? null;
  const startItem = start ? (itemsById.get(start.id) ?? null) : null;
  const startSure: Certainty = start ? startCertainty(graph, start.id) : "certain";

  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <PanelHeading>흐름 따라가기</PanelHeading>
        <button
          type="button"
          onClick={flow.clear}
          className="-mr-1.5 shrink-0 rounded-lg px-1.5 py-1 text-[12px] text-said-faint transition-colors hover:text-said-soft max-md:min-h-11"
        >
          그만 보기
        </button>
      </div>

      {/*
        Once, at the top, always. §1: the one thing this feature has to say
        about itself is that it did not open the app, and that it is showing
        the path the code makes possible rather than a path anything took.
      */}
      <p className="mt-2 text-[12px] leading-[1.75] text-said-faint text-pretty">
        {FLOW_NOTICE}
      </p>

      {session.question ? (
        <p className="rule-t mt-3 pt-3 text-[13px] leading-[1.7] text-said-soft text-pretty">
          {session.question}
        </p>
      ) : null}

      {session.missed !== null ? (
        <Missed text={session.missed} choices={session.candidates} onStart={onStart} />
      ) : null}

      {trace && trace.refusal !== null ? (
        <Refused
          text={flowRefusalSentence(trace.refusal, {
            name: trace.selected?.name ?? start?.name ?? "",
            kind: trace.selected?.kind ?? "file",
            imports: importCount,
          })}
          others={trace.otherStarts}
          onStart={onStart}
        />
      ) : null}

      {trace && start && flow.path ? (
        <Walked
          flow={flow}
          path={flow.path}
          start={startItem}
          startName={start.name}
          startKind={start.kind}
          startSure={startSure}
          note={session.note}
          itemsById={itemsById}
          described={described}
          onOpen={onOpen}
          onStart={onStart}
        />
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- refusals */

function Missed({
  text,
  choices,
  onStart,
}: {
  text: string;
  choices: readonly FlowChoice[];
  onStart: (itemId: string) => void;
}) {
  return (
    <div className="mt-4">
      <p className="hairline rounded-xl bg-ink px-4 py-3 text-[13px] leading-[1.8] text-said-soft text-pretty">
        {text}
      </p>
      {choices.length > 0 ? (
        <StartList
          label="따라가 볼 수 있는 흐름"
          items={choices.map((choice) => choice.item)}
          onStart={onStart}
        />
      ) : null}
    </div>
  );
}

function Refused({
  text,
  others,
  onStart,
}: {
  text: string;
  others: readonly GraphItem[];
  onStart: (itemId: string) => void;
}) {
  return (
    <div className="mt-4">
      <p className="hairline rounded-xl bg-ink px-4 py-3 text-[13px] leading-[1.8] text-said-soft text-pretty">
        {text}
      </p>
      {others.length > 0 ? (
        <StartList label="이 안에서 골라 보기" items={others} onStart={onStart} />
      ) : null}
    </div>
  );
}

/** A list of places a walk could begin instead. Every refusal ends with one. */
export function StartList({
  label,
  items,
  onStart,
  limit = 8,
}: {
  label: string;
  items: readonly GraphItem[];
  onStart: (itemId: string) => void;
  limit?: number;
}) {
  const shown = items.slice(0, limit);
  const hidden = items.length - shown.length;

  return (
    <div className="mt-4">
      <p className="label-kr text-[11px] text-said-faint">{label}</p>
      <ul className="mt-1.5 space-y-1">
        {shown.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onStart(item.id)}
              className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-ink max-md:min-h-11"
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-said-soft">
                {item.label ? displayName(item) : <code className="text-[12px]">{item.name}</code>}
              </span>
              <span className="shrink-0 text-[11px] text-said-faint">따라가 보기</span>
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="mt-1.5 text-[11px] text-said-faint tabular-nums">
          이 밖에 {hidden}곳이 더 있어요.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- the walk */

function Walked({
  flow,
  path,
  start,
  startName,
  startKind,
  startSure,
  note,
  itemsById,
  described,
  onOpen,
  onStart,
}: {
  flow: FlowControls;
  path: FlowPath;
  start: GraphItem | null;
  startName: string;
  startKind: GraphItem["kind"];
  startSure: Certainty;
  note: string;
  itemsById: ReadonlyMap<string, GraphItem>;
  described: ReadonlyMap<string, Description>;
  onOpen?: (id: string) => void;
  onStart: (itemId: string) => void;
}) {
  const { player, hops } = flow;
  const revealed = Math.min(player.revealed, hops);
  const shown = path.hops.slice(0, revealed);
  const done = revealed >= hops;

  const others = flow.paths.length - 1;
  const margin = flow.session?.trace?.margin ?? {
    criterion: null,
    gap: null,
    found: flow.paths.length,
    close: false,
  };
  const notes = flowNotes(path, itemsById, margin, others);
  const perHop = new Map<number, string[]>();
  const whole: string[] = [];
  for (const note of notes) {
    if (note.hop === null) whole.push(note.text);
    else perHop.set(note.hop, [...(perHop.get(note.hop) ?? []), note.text]);
  }

  return (
    <div className="mt-4">
      <header className="rule-t pt-3">
        <p className="label-kr text-[11px] text-said-faint">
          여기서부터 · {KIND_WORDS[startKind]}
        </p>
        <h3 className="display-kr mt-1 break-words text-[17px] text-said">
          {start?.label ? displayName(start) : <code className="text-[15px]">{startName}</code>}
        </h3>
        {note ? (
          <p className="mt-1.5 text-[12px] leading-[1.7] text-said-faint text-pretty">{note}</p>
        ) : null}
        {startSure === "inferred" ? (
          /*
            The address itself is a guess, which is a different claim from any
            hop on the path and the one that would otherwise go unsaid. Every
            Streamlit route in production is this — which script you run is a
            command line, not a file in the repository — and the walk cannot
            say so, because the entry joint is `certain` for the structural
            reason that reversing a `contains` is a fact rather than a claim.
          */
          <p className="mt-1.5 text-[12px] leading-[1.7] text-said-faint text-pretty">
            {GUESSED_START_NOTE}
          </p>
        ) : null}
        {/*
          The flow's one certainty label, and it is the weakest link rather
          than the last hop's — `neighbourhood.ts` rule 2, restated here for
          the same reason: a label taken from the end would launder a guess
          made in the middle. The start is part of the chain: if we are not
          sure the address is there, nothing that follows from it is surer.
        */}
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-said-soft tabular-nums">
          <CertaintyMark certainty={weaker(startSure, path.weakest)} />
          {CERTAINTY_WORDS[weaker(startSure, path.weakest)]} · 모두 {hops}걸음
        </p>
      </header>

      <PlayerControls
        player={player}
        hops={hops}
        reduced={flow.reduced}
        onPlayPause={flow.playPause}
        onStep={flow.stepBy}
        onReplay={flow.replay}
        onSeek={flow.seek}
        onShowAll={flow.showAll}
        onSpeed={flow.chooseSpeed}
      />

      <ol className="rule-t mt-3 space-y-1 pt-3">
        {shown.map((hop, at) => (
          <HopRow
            key={`${hop.index}:${hop.toId}`}
            hop={hop}
            item={itemsById.get(hop.toId) ?? null}
            line={described.get(hop.toId)?.line ?? null}
            current={at === shown.length - 1}
            notes={perHop.get(hop.index) ?? []}
            onSeek={() => flow.seek(hop.index)}
            onOpen={onOpen}
          />
        ))}
      </ol>

      {shown.some((hop) => hop.narrator !== "measured") ? (
        // Once under the list rather than on every marked row. The tag names
        // the distinction; this is what the tag means.
        <p className="mt-1.5 flex items-baseline gap-1.5 text-[11px] leading-[1.7] text-said-faint text-pretty">
          <span className="shrink-0 rounded-[3px] bg-lamp/10 px-1.5 text-[10px] leading-[1.6] text-lamp">
            {MODEL_TAG}
          </span>
          <span className="min-w-0">{MODEL_WROTE_IT}</span>
        </p>
      ) : null}

      {done ? (
        <>
          {/*
            The terminal, once the reader gets there. One of five sentences,
            every one of them written in `flow.ts` — including the two that are
            a refusal wearing an ending: a leaf says we could not find what
            leaves here, never that nothing does.
          */}
          <p className="rule-t mt-3 pt-3 text-[13px] leading-[1.8] text-said text-pretty">
            {path.text}
          </p>

          {whole.map((text) => (
            <p
              key={text}
              className="mt-2 text-[12px] leading-[1.75] text-said-faint text-pretty"
            >
              {text}
            </p>
          ))}

          {others > 0 ? (
            <Alternatives flow={flow} itemsById={itemsById} />
          ) : null}

          {flow.session?.candidates && flow.session.candidates.length > 1 ? (
            <StartList
              label="다른 곳에서 시작해 보기"
              items={flow.session.candidates
                .filter((choice) => choice.item.id !== start?.id)
                .map((choice) => choice.item)}
              onStart={onStart}
              limit={5}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * One step.
 *
 * The row wears the number the map draws on the line, the name of the place the
 * step lands, and **its measured sentence from the moment it appears** — never
 * a placeholder waiting for a better one (§5). Both sentences are free: the
 * target's own line from `describe.ts`, which is arithmetic the parser did, and
 * the hop's verb from `RELATION_WORDS` with the call-site line where we have
 * one. Neither has ever needed a model.
 *
 * The current row is the one the map is centred on and the one drawn heavy on
 * the canvas, and it is the only one that opens: the branch count, the outside
 * tools, and the way into the file. Putting those on every row would make a
 * twelve-step path a wall, and putting them nowhere would drop the one fact §1
 * insists on saying at every step — how many other ways out of here there were.
 */
function HopRow({
  hop,
  item,
  line,
  current,
  notes,
  onSeek,
  onOpen,
}: {
  hop: FlowHop;
  item: GraphItem | null;
  line: string | null;
  current: boolean;
  notes: readonly string[];
  onSeek: () => void;
  onOpen?: (id: string) => void;
}) {
  const name = item ? (item.label ? displayName(item) : item.name) : hop.toId;
  const canOpen = onOpen !== undefined && item !== null && item.path !== null;

  return (
    <li>
      <button
        type="button"
        onClick={onSeek}
        aria-current={current ? "step" : undefined}
        className={`block w-full rounded-lg px-2 py-1.5 text-left transition-colors max-md:min-h-11 ${
          current ? "bg-ink" : "hover:bg-ink/60"
        }`}
      >
        <span className="flex items-baseline gap-2">
          <span className="w-4 shrink-0 text-[11px] text-said-faint tabular-nums">
            {hop.index}
          </span>
          <span
            className={`min-w-0 flex-1 truncate text-[13px] ${
              current ? "text-said" : "text-said-soft"
            }`}
          >
            {item?.label ? name : <code className="text-[12px]">{name}</code>}
          </span>
          <CertaintyMark certainty={hop.certainty} />
        </span>

        {line ? (
          <span className="mt-0.5 block pl-6 text-[12px] leading-[1.7] text-said-faint text-pretty">
            {line}
          </span>
        ) : null}

        {/*
          What this connection is for. Pass 3's sentence where there is one —
          "여기서 가격을 사람이 읽는 모양으로 바꿔요" — and the relation's own verb
          where there is not, which is never wrong and never absent. A joint
          says the structural fact instead ("이 주소는 page.tsx 가 맡고 있어요"),
          because a route does not call anything; a file answers for it.

          Marked when a model wrote it. §5: the UI has to be able to say who
          wrote a sentence, exactly as `Description.fromModel` draws the same
          line — an arithmetic sentence and a model's look alike and must not
          read alike. The mark goes on the model's, because the unmarked one is
          the measured one and measured is this product's floor.
        */}
        <span className="mt-0.5 flex items-baseline gap-1.5 pl-6 text-[12px] leading-[1.7] text-said-soft text-pretty">
          <span className="min-w-0">{hop.text}</span>
          {hop.narrator === "purpose" || hop.narrator === "model" ? <ModelMark /> : null}
        </span>
      </button>

      {current ? (
        <div className="pl-8 pr-2">
          <p className="text-[11px] leading-[1.7] text-said-faint tabular-nums text-pretty">
            {branchesNote(hop.branches)}
          </p>

          {hop.joint !== null ? (
            /*
              Said rather than left to be noticed. A joint is two `contains`
              edges read in opposite directions with the file collapsed out, so
              no connection in the graph has this step's two ends and the map
              draws no line for it (D79). A step with no line on the picture is
              a discrepancy the reader would otherwise have to explain to
              themselves.
            */
            <p className="mt-0.5 text-[11px] leading-[1.7] text-said-faint text-pretty">
              이 걸음은 파일이 맡고 있다는 뜻이라, 지도에는 잇는 선이 없어요.
            </p>
          ) : null}

          {hop.packages.length > 0 ? (
            <p className="mt-0.5 text-[11px] leading-[1.7] text-said-faint text-pretty">
              이 자리가 있는 파일은 밖에서 가져온 도구{" "}
              {hop.packages.map((name) => `\`${name}\``).join(", ")}를 써요.
            </p>
          ) : null}

          {notes.map((text) => (
            <p key={text} className="mt-1 text-[11px] leading-[1.7] text-said-faint text-pretty">
              {text}
            </p>
          ))}

          {canOpen && item ? (
            <button
              type="button"
              onClick={() => onOpen?.(item.id)}
              className="mt-1.5 rounded-lg border border-edge-lit px-2.5 py-1 text-[12px] text-said-soft transition-colors hover:border-said-faint hover:bg-ink hover:text-said max-md:min-h-11"
            >
              {item.startLine === null || item.kind === "file"
                ? "파일 열어보기"
                : `${item.startLine}줄부터 열어보기`}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The runner-up paths, which the beam already had in hand.
 *
 * §7's alternatives sentence ends "아래에서 바꿔 볼 수 있어요", so this is what it
 * means. Each one is named by where it ends and how long it is, which are two
 * of the three things a reader can actually perceive about a path (§8.4) — the
 * third, how sure we are, is the mark beside it.
 */
function Alternatives({
  flow,
  itemsById,
}: {
  flow: FlowControls;
  itemsById: ReadonlyMap<string, GraphItem>;
}) {
  return (
    <div className="mt-4">
      <p className="label-kr text-[11px] text-said-faint">다른 길로 가 보기</p>
      <ul className="mt-1.5 space-y-1">
        {flow.paths.map((one, at) => {
          const end = itemsById.get(one.endId) ?? null;
          const name = end ? (end.label ? displayName(end) : end.name) : one.endId;
          const chosen = at === flow.pathAt;
          return (
            <li key={`${at}:${one.endId}`}>
              <button
                type="button"
                onClick={() => flow.choosePath(at)}
                aria-pressed={chosen}
                className={`-mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-2 rounded-md px-1.5 py-1 text-left transition-colors max-md:min-h-11 ${
                  chosen ? "bg-ink" : "hover:bg-ink"
                }`}
              >
                <CertaintyMark certainty={one.weakest} />
                <span
                  className={`min-w-0 flex-1 truncate text-[13px] ${
                    chosen ? "text-said" : "text-said-soft"
                  }`}
                >
                  {name}
                </span>
                <span className="shrink-0 text-[11px] text-said-faint tabular-nums">
                  {one.hops.length}걸음
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
