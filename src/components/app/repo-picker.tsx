"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { addProject, listMyRepos, type MyReposState } from "@/app/app/actions";

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

  if (state === null) {
    return (
      <p className="py-6 text-[14px] text-said-faint">저장소 목록을 가져오는 중…</p>
    );
  }

  if (state.status === "no_github") {
    return (
      <p className="py-6 text-[14px] leading-[1.75] text-said-soft">
        GitHub 계정이 연결돼 있지 않아요. 아래에 저장소 주소를 직접 붙여넣거나,
        로그아웃 후 GitHub으로 다시 로그인하시면 목록에서 고를 수 있어요.
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p role="alert" className="py-6 text-[14px] leading-[1.75] text-c4">
        {state.message}
      </p>
    );
  }

  return (
    <div>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="저장소 이름으로 찾기"
        aria-label="저장소 검색"
        className="w-full rounded-xl border border-edge bg-ink px-4 py-2.5 text-[14px] placeholder:text-said-faint focus:border-edge-lit"
      />

      <ul className="mt-3 max-h-[340px] divide-y divide-edge overflow-y-auto rounded-xl border border-edge">
        {filtered.length === 0 ? (
          <li className="px-4 py-8 text-center text-[14px] text-said-faint">
            {query ? "찾는 저장소가 없어요." : "공개 저장소가 없어요."}
          </li>
        ) : (
          filtered.map((repo) => {
            const key = `${repo.owner}/${repo.name}`;
            const busy = connecting === key;
            return (
              <li
                key={key}
                className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-ink-raised"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">{repo.name}</p>
                  <p className="truncate text-[13px] text-said-faint">
                    {repo.description || repo.fullName}
                  </p>
                </div>
                <div className="hidden shrink-0 text-right text-[12px] text-said-faint sm:block">
                  {repo.language ? <div>{repo.language}</div> : null}
                  <div>{agoInKorean(repo.pushedAt)}</div>
                </div>
                <button
                  type="button"
                  onClick={() => connect(repo.owner, repo.name)}
                  disabled={busy || repo.connected || connecting !== null}
                  className="shrink-0 rounded-lg bg-paper px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-lamp disabled:bg-ink-raised disabled:text-said-faint"
                >
                  {repo.connected ? "연결됨" : busy ? "확인 중…" : "연결"}
                </button>
              </li>
            );
          })
        )}
      </ul>

      {error ? (
        <p role="alert" className="mt-3 text-[14px] text-c4">
          {error}
        </p>
      ) : null}

      {/*
        Say where the missing ones went. The MVP reads public repositories only,
        and a user whose repo is simply absent from this list would reasonably
        assume the product is broken.
      */}
      {state.privateCount > 0 ? (
        <p className="mt-3 text-[13px] leading-[1.7] text-said-faint">
          비공개 저장소 {state.privateCount}개는 목록에 없어요. 지금은 공개
          저장소만 읽을 수 있어요.
        </p>
      ) : null}
      {state.more ? (
        <p className="mt-1 text-[13px] text-said-faint">
          최근에 작업한 100개만 보여드리고 있어요. 없으면 아래에 주소를 직접
          붙여넣어 주세요.
        </p>
      ) : null}
    </div>
  );
}
