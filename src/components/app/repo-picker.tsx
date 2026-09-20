"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { addProject, listMyRepos, type MyReposState } from "@/app/app/actions";

import { LanguageMark } from "./language-mark";

/**
 * The shape the list has while it is still being fetched.
 *
 * Fixed widths rather than random ones. This component is server-rendered
 * before its effect ever runs, so the loading state goes down the wire; a width
 * drawn from `Math.random()` would differ between the server's HTML and the
 * client's first render, which is a hydration mismatch. They are uneven on
 * purpose — five bars of identical length read as a barcode rather than as
 * names waiting to arrive.
 *
 * The two bars per row are wrapped in boxes the height of the real row's two
 * lines (15px and 13px type at the body's 1.72 leading, so 26 and 22), which is
 * what makes the list stop jumping when the real rows replace these.
 */
const LOADING_ROWS: { name: string; detail: string }[] = [
  { name: "58%", detail: "77%" },
  { name: "41%", detail: "88%" },
  { name: "67%", detail: "59%" },
  { name: "36%", detail: "82%" },
  { name: "52%", detail: "71%" },
];

/** "3일 전". Absolute dates mean nothing when you are looking for the one you touched last. */
function agoInKorean(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}개월 전`;
  return `${Math.floor(months / 12)}년 전`;
}

export function RepoPicker({
  onConnected,
}: {
  onConnected: (message: string) => void;
}) {
  const [state, setState] = useState<MyReposState | null>(null);
  const [query, setQuery] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    listMyRepos().then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Derived inside the memo, not above it: a fresh array on every render would
  // invalidate the memo every render and make it decoration.
  const filtered = useMemo(() => {
    const repos = state?.status === "ok" ? state.repos : [];
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (repo) =>
        repo.fullName.toLowerCase().includes(q) ||
        (repo.description ?? "").toLowerCase().includes(q),
    );
  }, [state, query]);

  function connect(owner: string, name: string) {
    setConnecting(`${owner}/${name}`);
    setError(null);
    const form = new FormData();
    form.set("url", `https://github.com/${owner}/${name}`);
    startTransition(async () => {
      const result = await addProject({ status: "idle" }, form);
      setConnecting(null);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      if (result.status === "ok") {
        onConnected(
          result.existing
            ? `${result.displayName}은(는) 이미 연결돼 있어요.`
            : `${result.displayName} 연결했어요. ${result.summary}`,
        );
        setState((previous) =>
          previous?.status === "ok"
            ? {
                ...previous,
                repos: previous.repos.map((repo) =>
                  repo.owner === owner && repo.name === name
                    ? { ...repo, connected: true }
                    : repo,
                ),
              }
            : previous,
        );
      }
    });
  }

  if (state?.status === "no_github") {
    return (
      // The paste field is a sibling tab, not something below this paragraph —
      // pointing "아래에" at it sent people looking for a field that is not on
      // screen. It is named instead.
      //
      // In a panel rather than loose in the card. This is the whole of what
      // this tab has to show a Google-signed-in visitor, and a paragraph
      // floating in an otherwise empty card reads as the list having failed to
      // arrive rather than as an answer.
      <div className="hairline rounded-xl bg-ink px-5 py-4">
        <p className="text-[14px] leading-[1.75] text-said-soft">
          GitHub 계정이 연결돼 있지 않아요. “붙여넣기”에 저장소 주소를 직접
          넣거나, 로그아웃 후 GitHub으로 다시 로그인하시면 목록에서 고를 수
          있어요.
        </p>
      </div>
    );
  }

  if (state?.status === "error") {
    return (
      <div role="alert" className="hairline rounded-xl bg-ink px-5 py-4">
        <p className="text-[14px] leading-[1.75] text-c4">{state.message}</p>
      </div>
    );
  }

  /*
   * Loading and loaded are the same layout, not two screens.
   *
   * This was one line of 14px faint text, which the full picker then replaced:
   * a search field, a bordered list and up to a hundred rows arrived at once,
   * several hundred pixels tall, and the card changed size under the pointer.
   * The field below is rendered either way — disabled while there is nothing to
   * search — and the list keeps its box and fills it with rows the exact height
   * of the real ones. Nothing moves when the repositories land; the bars are
   * replaced by names in place.
   */
  const loading = state === null;

  return (
    /*
     * A column that fills whatever height it is given, so the list inside it is
     * the ONE thing on this side of the dashboard that scrolls. It used to have
     * a fixed 340px list inside a card inside a scrolling column, which put two
     * bars side by side — the outer one with almost nothing to move.
     */
    <div className="flex h-full min-h-0 flex-col">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        disabled={loading}
        placeholder="저장소 이름으로 찾기"
        aria-label="저장소 검색"
        className="hairline w-full shrink-0 rounded-xl bg-ink px-4 py-2.5 text-[14px] transition-colors placeholder:text-said-faint focus:border-edge-lit disabled:placeholder:text-said-faint/50"
      />

      {/*
        `bg-ink`, which is the fix for a hover that was rendering as nothing.
        The list had no background of its own, so it showed the card behind it
        — `ink-raised` — and every row's `hover:bg-ink-raised` painted the
        colour that was already there. Recessing the list to `ink` pairs it with
        the search field directly above, and gives the row hover somewhere to
        go.

        One `animate-pulse` on the list rather than one per row: five rows
        breathing on five separate animations drift apart and read as five
        objects, where the list is one object that has not arrived yet. The
        global reduced-motion block in `globals.css` collapses the duration, so
        this needs no guard of its own — the bars simply stop breathing and
        stay where they are.
      */}
      <ul
        className={`hairline mt-3 min-h-[160px] flex-1 divide-y divide-edge rounded-xl bg-ink ${
          loading ? "animate-pulse overflow-hidden" : "overflow-y-auto"
        }`}
      >
        {loading ? (
          // `aria-hidden`, with the sentence below carrying the state: these
          // bars mean "wait" to an eye and nothing at all to a screen reader,
          // which would otherwise be read five empty list items.
          LOADING_ROWS.map((row, index) => (
            <li
              key={index}
              aria-hidden
              className="flex items-center gap-4 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex h-[26px] items-center">
                  <div
                    className="h-[10px] rounded-[3px] bg-edge-lit"
                    style={{ width: row.name }}
                  />
                </div>
                <div className="flex h-[22px] items-center">
                  <div
                    className="h-[8px] rounded-[3px] bg-edge"
                    style={{ width: row.detail }}
                  />
                </div>
              </div>
              <div className="h-[38px] w-[60px] shrink-0 rounded-lg bg-edge" />
            </li>
          ))
        ) : filtered.length === 0 ? (
          <li className="px-4 py-10 text-center text-[14px] text-said-faint">
            {query ? "찾는 저장소가 없어요." : "공개 저장소가 없어요."}
          </li>
        ) : (
          filtered.map((repo) => {
            const key = `${repo.owner}/${repo.name}`;
            const busy = connecting === key;
            return (
              <li
                key={key}
                className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-ink-raised"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">{repo.name}</p>
                  <p className="truncate text-[13px] text-said-faint transition-colors group-hover:text-said-soft">
                    {repo.description || repo.fullName}
                  </p>
                </div>
                {/* One line rather than two, now that the language is a mark:
                    stacked, it made every row two lines tall in a column that
                    is the narrowest thing on the page. */}
                <div className="hidden shrink-0 items-center gap-1.5 text-[12px] text-said-faint sm:flex">
                  <LanguageMark language={repo.language} />
                  <span className="tabular-nums">
                    {agoInKorean(repo.pushedAt)}
                  </span>
                </div>
                {/*
                  Three states, and they used to be two looks.

                  "연결" is the action, so it is the light surface — the
                  palette's rule is that light means "you act here". "확인 중…"
                  is that same action mid-flight, so it stays light and dims,
                  which is what every other pending button in this product does.
                  "연결됨" is neither: it is a fact about a repository you have
                  already dealt with, and painting it as a filled panel made the
                  rows you are DONE with the heaviest things in the list. It
                  gives up its fill and becomes a hairline chip.
                */}
                <button
                  type="button"
                  onClick={() => connect(repo.owner, repo.name)}
                  disabled={busy || repo.connected || connecting !== null}
                  // The border is on the base, transparent on the filled
                  // variant: a chip that grows a 0.8px edge only when it says
                  // 연결됨 would be 1.6px taller than its neighbours, and a
                  // column of buttons at two heights is the ragged edge this
                  // list is otherwise careful about.
                  className={`shrink-0 rounded-lg border-[0.8px] px-4 py-2 text-[13px] transition-colors ${
                    repo.connected
                      ? "border-edge bg-transparent font-medium text-said-faint"
                      : "border-transparent bg-paper font-semibold text-ink hover:bg-lamp disabled:opacity-40"
                  }`}
                >
                  {repo.connected ? "연결됨" : busy ? "확인 중…" : "연결"}
                </button>
              </li>
            );
          })
        )}
      </ul>

      {/*
        The loading sentence keeps its words and moves under the list it
        describes, where the notes about private and truncated repositories also
        sit. `role="status"` rather than a bare paragraph: with the bars hidden
        from the accessibility tree, this is the only thing that says the list
        is on its way.
      */}
      {loading ? (
        <p
          role="status"
          className="mt-3 shrink-0 text-[13px] text-said-faint"
        >
          저장소 목록을 가져오는 중…
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 shrink-0 text-[14px] leading-[1.7] text-c4">
          {error}
        </p>
      ) : null}

      {/*
        Say where the missing ones went. The MVP reads public repositories only,
        and a user whose repo is simply absent from this list would reasonably
        assume the product is broken.
      */}
      {state !== null && state.privateCount > 0 ? (
        <p className="mt-3 shrink-0 text-[13px] leading-[1.7] text-said-faint">
          비공개 저장소 {state.privateCount}개는 목록에 없어요. 지금은 공개
          저장소만 읽을 수 있어요.
        </p>
      ) : null}
      {state !== null && state.more ? (
        <p className="mt-1 shrink-0 text-[13px] text-said-faint">
          최근에 작업한 100개만 보여드리고 있어요. 없으면 “붙여넣기”에 주소를
          직접 넣어 주세요.
        </p>
      ) : null}
    </div>
  );
}
