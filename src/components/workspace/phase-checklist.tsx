import type {
  AnalysisProgress,
  ProjectSource,
} from "./analysis-screen";

/**
 * The checklist a person watches while their project is being read.
 *
 * It is a checklist and not a log on purpose. The brief asks for a "live
 * activity log", and a scrolling list of file names is a terminal — the most
 * alienating object in a developer tool for someone who cannot read code
 * (UI_DIRECTION section 4). The same information, in five lines that tick off,
 * has the one property a log can never have: a visible end. The file-by-file
 * list still exists, one disclosure away, for whoever wants it.
 *
 * Every line here is derived from an event that actually arrived. There is no
 * row that fills itself on a timer, and no row that claims a step happened
 * because the step before it did.
 */

/**
 * Five states, and the distinction between the last two is the honest one.
 *
 * `stopped` is a step that was under way when the run failed — it is not a
 * failure of that step, so it gets a dash rather than a cross. `unavailable`
 * is a step this product cannot do yet (naming features needs Pass 2, which is
 * Step 4), and saying so is better than a checkmark for work nobody did.
 */
export type ChecklistRowState =
  | "waiting"
  | "active"
  | "done"
  | "stopped"
  | "unavailable";

export type PhaseRow = {
  id: "ingest" | "read" | "structure" | "connections" | "features";
  /** Reads differently once the step is over — "읽는 중" becomes "읽었어요". */
  title: string;
  /** The counter sentence. Null while there is genuinely nothing to report. */
  detail: string | null;
  state: ChecklistRowState;
  /** Only once a denominator has arrived. Never a guess at one. */
  progress: { done: number; total: number } | null;
};

const ko = (n: number) => n.toLocaleString("ko-KR");

/**
 * Turn the stream's running totals into five lines.
 *
 * Pure, and exported separately from the component, so every state this screen
 * can be in is reachable in a test without a browser — which matters more than
 * usual here, because most of these states only occur on a repository that is
 * mid-analysis and cannot be summoned on demand.
 */
export function buildPhaseRows(
  progress: AnalysisProgress,
  source: ProjectSource,
): PhaseRow[] {
  const {
    phase,
    filesRead,
    filesTotal,
    filesOffered,
    itemsFound,
    connectionsFound,
    featuresNamed,
    failure,
    completion,
  } = progress;

  const stopped = failure !== null;
  const finished = completion !== null;
  // The analyzer emits phase "done" before the graph is written, so there is a
  // real window where the reading is over and the run is not. Treating it as
  // past-tense here is correct; the headline says what is still happening.
  const parsingOver = finished || phase === "done" || phase === "semantic";

  // Ingest is over the moment `run.started` lands, because that event is the
  // first thing that can only exist after the files are in hand.
  const ingested = filesOffered !== null;

  const rows: PhaseRow[] = [];

  const ingestState: ChecklistRowState = ingested
    ? "done"
    : stopped
      ? "stopped"
      : "active";
  rows.push({
    id: "ingest",
    title: title(
      ingestState,
      source === "upload"
        ? { waiting: "폴더 정리", active: "폴더 정리하는 중", done: "폴더 정리했어요" }
        : { waiting: "코드 가져오기", active: "코드 가져오는 중", done: "코드 가져왔어요" },
    ),
    // Nothing to say until it is over: the download reports no progress at all
    // (the ingest messages go to the server log), and inventing a number here
    // would be the one thing this screen is not allowed to do.
    detail: ingested
      ? source === "upload"
        ? `파일 ${ko(filesOffered)}개 준비했어요`
        : `파일 ${ko(filesOffered)}개 받았어요`
      : null,
    state: ingestState,
    progress: null,
  });

  const readState = rowState({
    started: ingested || filesRead > 0,
    over: parsingOver,
    stopped,
    finished,
  });
  rows.push({
    id: "read",
    title: title(readState, {
      waiting: "파일 읽기",
      active: "파일 읽는 중",
      done: "파일 다 읽었어요",
    }),
    detail: finished
      ? completion.filesSkipped > 0
        ? `${ko(completion.filesParsed)}개 읽었어요 · ${ko(completion.filesSkipped)}개는 읽을 게 없어서 넘어갔어요`
        : `${ko(completion.filesParsed)}개 읽었어요`
      : filesRead > 0
        ? filesTotal !== null
          ? `${ko(filesRead)} / ${ko(filesTotal)}`
          : `${ko(filesRead)}개 읽었어요`
        : null,
    state: readState,
    // The denominator is every file we could open, which is an upper bound on
    // what any one analyzer chooses to parse — so the bar can finish short of
    // the end. `run.completed` carries the real figure and replaces it.
    progress:
      !finished && filesTotal !== null && filesTotal > 0
        ? { done: Math.min(filesRead, filesTotal), total: filesTotal }
        : null,
  });

  const items = finished ? completion.itemCount : itemsFound;
  const structureState = rowState({
    started: items > 0,
    over: parsingOver,
    stopped,
    finished,
  });
  rows.push({
    id: "structure",
    title: title(structureState, {
      waiting: "구조 파악",
      active: "구조 파악 중",
      done: "구조 다 봤어요",
    }),
    detail: items > 0 ? `${ko(items)}개 찾았어요` : null,
    state: structureState,
    progress: null,
  });

  const connections = finished ? completion.connectionCount : connectionsFound;
  const connectionState = rowState({
    started: connections > 0,
    over: parsingOver,
    stopped,
    finished,
  });
  rows.push({
    id: "connections",
    title: title(connectionState, {
      waiting: "연결 정리",
      active: "연결 정리 중",
      done: "연결 다 정리했어요",
    }),
    // The brief allows "아는 연결이 없어요" and forbids calling anything safe.
    // A finished run with nothing to show says the first of those plainly.
    detail:
      connections > 0
        ? `${ko(connections)}개 정리했어요`
        : finished
          ? "아는 연결이 없어요"
          : null,
    state: connectionState,
    progress: null,
  });

  const featureState: ChecklistRowState =
    featuresNamed > 0
      ? phase === "semantic" && !finished
        ? "active"
        : "done"
      : "unavailable";
  rows.push({
    id: "features",
    title: title(featureState, {
      waiting: "기능 이름 붙이기",
      active: "기능 이름 붙이는 중",
      done: "기능에 이름 붙였어요",
    }),
    detail:
      featuresNamed > 0
        ? `기능 ${ko(featuresNamed)}개에 이름을 붙였어요`
        : // Pass 2 does not exist yet. A greyed line that says so is honest;
          // a checkmark would be a claim about work nobody did, and leaving the
          // row out would hide a step the product still owes the user.
          "아직 준비 중인 단계예요",
    state: featureState,
    progress: null,
  });

  return rows;
}

/**
 * A step's name in the tense it has earned.
 *
 * Four rows all reading "…하는 중" on the first paint would say four things are
 * happening when one is. The dictionary form is what a step that has not begun
 * is called, and it is also the honest name for a step the run stopped before.
 */
function title(
  state: ChecklistRowState,
  words: { waiting: string; active: string; done: string },
): string {
  if (state === "done") return words.done;
  if (state === "active") return words.active;
  return words.waiting;
}

function rowState(input: {
  started: boolean;
  over: boolean;
  stopped: boolean;
  finished: boolean;
}): ChecklistRowState {
  if (input.finished) return "done";
  if (input.stopped) return input.started ? "stopped" : "waiting";
  if (input.over) return input.started ? "done" : "waiting";
  return input.started ? "active" : "waiting";
}

export function PhaseChecklist({ rows }: { rows: readonly PhaseRow[] }) {
  return (
    <ol className="flex flex-col gap-px">
      {rows.map((row) => (
        <li
          key={row.id}
          className={`flex items-baseline gap-3 rounded-lg px-3 py-2.5 transition-colors ${
            row.state === "active" ? "bg-ink-raised" : ""
          }`}
        >
          <Marker state={row.state} />

          <span
            className={`text-[15px] leading-[1.6] ${
              row.state === "done"
                ? "text-said-soft"
                : row.state === "active"
                  ? "font-semibold text-said"
                  : row.state === "stopped"
                    ? "text-said-soft"
                    : "text-said-faint"
            }`}
          >
            {row.title}
          </span>

          <span className="ml-auto flex items-center gap-2.5 text-right">
            {row.progress ? (
              <span
                className="hidden h-[3px] w-24 overflow-hidden rounded-full bg-edge sm:block"
                aria-hidden="true"
              >
                <span
                  className="block h-full rounded-full bg-lamp transition-[width] duration-300 ease-out"
                  style={{
                    width: `${Math.round((row.progress.done / row.progress.total) * 100)}%`,
                  }}
                />
              </span>
            ) : null}

            {row.detail ? (
              <span
                className={`text-[13px] tabular-nums ${
                  row.state === "unavailable" ? "text-said-faint" : "text-said-soft"
                }`}
              >
                {row.detail}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The state marker.
 *
 * Deliberately not an icon set: a filled ring for what is happening, a check
 * for what is done, a dash for what stopped, and a dot for what has not
 * started. The dash matters — a step that was interrupted by a failed download
 * did not itself fail, and a red cross would say it did.
 */
function Marker({ state }: { state: ChecklistRowState }) {
  const label = {
    waiting: "아직",
    active: "하는 중",
    done: "끝났어요",
    stopped: "멈췄어요",
    unavailable: "아직 준비 중",
  }[state];

  return (
    <span
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center"
      role="img"
      aria-label={label}
    >
      {state === "done" ? (
        <svg viewBox="0 0 16 16" className="h-[14px] w-[14px] text-lamp" aria-hidden="true">
          <path
            d="M3 8.6l3.2 3.2L13 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : state === "active" ? (
        <span className="relative flex h-[9px] w-[9px]">
          {/* The only looping animation on this screen, and it carries meaning:
              it marks the step the machine is inside right now. The global
              reduced-motion rule flattens it to a still ring. */}
          <span className="vc-pulse absolute inset-0 rounded-full bg-lamp/35" />
          <span className="relative h-[9px] w-[9px] rounded-full bg-lamp" />
        </span>
      ) : state === "stopped" ? (
        <span className="h-[2px] w-[10px] rounded-full bg-c4" />
      ) : (
        <span
          className={`h-[6px] w-[6px] rounded-full ${
            state === "unavailable" ? "bg-edge-lit" : "bg-wire"
          }`}
        />
      )}
    </span>
  );
}
