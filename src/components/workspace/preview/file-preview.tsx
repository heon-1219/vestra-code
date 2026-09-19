"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GraphItem } from "@/lib/graph/view";

import {
  formatBytes,
  githubBlobUrl,
  lineWindow,
  previewShapeFor,
  PREVIEW_MESSAGES,
  type PreviewRefusal,
  type PreviewShape,
} from "./preview-kinds";

/**
 * Opening a file and looking at it.
 *
 * A popup rather than a panel, because looking at a file is a detour: you were
 * reading the map, you wanted to check one thing, and you are going back. A
 * third column would make it a place you have to navigate out of.
 *
 * What it owes the person using it:
 *
 *   - **Escape closes it, and the focus goes back to whatever opened it.**
 *     Someone who arrived here with the keyboard has to be able to leave the
 *     same way, and landing back at the top of the page instead of on the file
 *     they clicked means losing their place in their own project.
 *   - **Tab stays inside.** A popup you can tab out of while it still covers
 *     the screen is a trap of the other kind: the focus ring is somewhere
 *     behind the overlay and nothing responds.
 *   - **The page behind does not scroll**, and at 375px the popup is the whole
 *     screen, because a centred box with margins on a phone is a smaller
 *     reading area for no reason.
 *
 * And what it owes section 3: the line at the bottom. This is the one screen in
 * the product where source code is on display, so it is the one screen that has
 * to say where the code came from and that we did not keep it.
 */

export type PreviewFocus = { startLine: number; endLine: number | null };

export type PreviewTarget = {
  /** Repo-relative path, exactly as the map holds it. */
  path: string;
  /** What the person calls this thing. */
  title: string;
  /** The lines to land on, when a part of a file was selected rather than the file. */
  focus: PreviewFocus | null;
};

export type FilePreviewProps = {
  projectId: string;
  source: "github" | "upload";
  /** Null for an uploaded folder, which has no repository behind it. */
  repo: { owner: string; name: string; ref?: string | null } | null;
  target: PreviewTarget;
  onClose: () => void;
};

/**
 * What to open when someone points at an item on the map.
 *
 * A file opens itself. A component or a helper opens the file it lives in, at
 * its own lines — which is what a person means by "show me the Pay button",
 * even though the thing they named is not a file. Anything with no path (a
 * package, a feature) has nothing to open, and says so by returning null.
 */
export function previewTargetFor(item: GraphItem): PreviewTarget | null {
  if (!item.path) return null;
  return {
    path: item.path,
    title: item.label ?? item.name,
    focus:
      item.kind !== "file" && item.startLine !== null
        ? { startLine: item.startLine, endLine: item.endLine }
        : null,
  };
}

type ViewState =
  | { state: "loading" }
  | { state: "code"; text: string; size: number | null }
  | { state: "image"; url: string; size: number | null }
  | { state: "pdf"; url: string }
  | { state: "refused"; reason: PreviewRefusal | "spreadsheet"; message: string };

export function FilePreview({
  projectId,
  source,
  repo,
  target,
  onClose,
}: FilePreviewProps) {
  const shape = useMemo(() => previewShapeFor(target.path), [target.path]);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const fileUrl = useMemo(() => {
    const params = new URLSearchParams({ path: target.path });
    if (target.focus) params.set("line", String(target.focus.startLine));
    return `/api/projects/${projectId}/file?${params.toString()}`;
  }, [projectId, target.path, target.focus]);

  const viewOnGithub = useMemo(
    () => (repo ? githubBlobUrl(repo, target.path, target.focus) : null),
    [repo, target.path, target.focus],
  );

  /**
   * The answers that need no network, worked out while rendering.
   *
   * An uploaded folder, a spreadsheet, a file type we have no viewer for, and
   * the PDF — which is an address handed to the browser rather than bytes we
   * fetched. None of these waits on anything, so none of them should flash
   * "받아오는 중" first: a popup that says it is loading and then says it never
   * could have loaded is the product looking like it tried and failed, when in
   * fact it knew the answer before it opened.
   */
  const immediate = useMemo<ViewState | null>(() => {
    // D66: there is no origin to fetch from and we kept no copy.
    if (source === "upload") {
      return { state: "refused", reason: "upload", message: PREVIEW_MESSAGES.upload };
    }
    if (shape.kind === "spreadsheet") {
      return {
        state: "refused",
        reason: "spreadsheet",
        message: PREVIEW_MESSAGES.spreadsheet,
      };
    }
    if (shape.contentType === null) {
      return { state: "refused", reason: "unsupported", message: PREVIEW_MESSAGES.unknown };
    }
    /*
     * The PDF goes to the browser as an address.
     *
     * It already has a whole PDF engine and we are not adding a second one as a
     * dependency. What that costs: the file transfers in full before anything
     * appears, the viewer ignores our theme entirely, and on most phones it
     * declines to render inline at all — which is why there is real fallback
     * content inside the <object> rather than an empty frame.
     */
    if (shape.kind === "pdf") return { state: "pdf", url: fileUrl };
    return null;
  }, [source, shape, fileUrl]);

  /* ------------------------------------------------ getting the bytes */

  // Kept with the address it came from, so switching files shows "받아오는 중"
  // again without anyone having to reset it.
  const [fetched, setFetched] = useState<{ url: string; value: ViewState } | null>(null);

  useEffect(() => {
    if (immediate) return;

    const controller = new AbortController();
    let objectUrl: string | null = null;

    void (async () => {
      const settle = (value: ViewState) => {
        if (!controller.signal.aborted) setFetched({ url: fileUrl, value });
      };

      try {
        const response = await fetch(fileUrl, { signal: controller.signal });

        if (!response.ok) {
          // Every refusal from the route is already a Korean sentence written
          // for this person. Showing it is the job.
          settle(await readRefusal(response));
          return;
        }

        if (shape.kind === "image") {
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          settle({ state: "image", url: objectUrl, size: blob.size });
          return;
        }

        const text = await response.text();
        settle({ state: "code", text, size: byteLength(text) });
      } catch {
        settle({ state: "refused", reason: "github", message: PREVIEW_MESSAGES.failed });
      }
    })();

    return () => {
      controller.abort();
      // The bytes leave with the popup. Nothing about this file outlives it.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [immediate, fileUrl, shape.kind]);

  const view: ViewState =
    immediate ?? (fetched?.url === fileUrl ? fetched.value : { state: "loading" });

  /* ------------------------------------------------------ the popup itself */

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // The close button rather than the panel: a screen reader then reads the
    // dialog's name and the way out, in that order.
    closeRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      // Back to the thing they clicked, not to the top of the page.
      opener?.focus();
    };
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableIn(panelRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  const titleId = "file-preview-title";

  return (
    <div
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        // Only a press that started on the backdrop itself. A drag that began
        // inside the panel — selecting a line of code and overshooting — must
        // not close the thing being read.
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-ink-sunk/85 p-0 sm:items-center sm:p-6"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full min-w-0 flex-col overflow-hidden border-edge-lit bg-ink-raised sm:h-auto sm:max-h-[min(88vh,52rem)] sm:max-w-[64rem] sm:rounded-2xl sm:border"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-edge px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-[12px] text-said-faint">{shape.word}</p>
              {shape.language ? (
                <span className="rounded border border-edge-lit px-1.5 py-px text-[11px] text-said-faint">
                  {shape.language}
                </span>
              ) : null}
            </div>
            <h2
              id={titleId}
              className="mt-0.5 truncate text-[16px] font-semibold tracking-[-0.02em] text-said"
              title={target.title}
            >
              {target.title}
            </h2>
            <p
              className="mt-1 truncate font-mono text-[11px] text-said-faint"
              title={target.path}
            >
              {target.path}
              {target.focus
                ? ` · ${target.focus.startLine}–${target.focus.endLine ?? target.focus.startLine}줄`
                : ""}
            </p>
          </div>

          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-edge-lit px-3 py-1.5 text-[13px] text-said-soft transition-colors hover:text-said"
          >
            닫기
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          <Body view={view} shape={shape} focus={target.focus} onGithub={viewOnGithub} />
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-edge px-4 py-2.5">
          <p className="text-[11px] leading-[1.7] text-said-faint">
            {PREVIEW_MESSAGES.trust}
          </p>
          {viewOnGithub ? (
            <a
              href={viewOnGithub}
              target="_blank"
              rel="noreferrer noopener"
              className="shrink-0 text-[12px] text-said-soft underline underline-offset-4 transition-colors hover:text-said"
            >
              GitHub에서 보기
            </a>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- the body */

function Body({
  view,
  shape,
  focus,
  onGithub,
}: {
  view: ViewState;
  shape: PreviewShape;
  focus: PreviewFocus | null;
  onGithub: string | null;
}) {
  if (view.state === "loading") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-[14px] text-said-soft">파일을 받아오는 중이에요.</p>
      </div>
    );
  }

  if (view.state === "refused") {
    return <Refused message={view.message} onGithub={onGithub} />;
  }

  if (view.state === "image") {
    return <ImageBody url={view.url} size={view.size} />;
  }

  if (view.state === "pdf") {
    return (
      <object data={view.url} type="application/pdf" className="h-full min-h-[24rem] w-full">
        {/*
          Shown when the browser will not draw a PDF inline, which on a phone is
          most of the time. It is real content, not a placeholder: the way to
          read the file is right here.
        */}
        <div className="flex h-full items-center justify-center p-8">
          <div className="max-w-[40ch] text-center">
            <p className="text-[14px] leading-[1.8] text-said-soft">
              이 브라우저에서는 PDF를 바로 펼쳐 보여드릴 수 없어요.
            </p>
            {onGithub ? (
              <a
                href={onGithub}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-3 inline-block text-[13px] font-medium text-lamp underline underline-offset-4"
              >
                GitHub에서 열어보기
              </a>
            ) : null}
          </div>
        </div>
      </object>
    );
  }

  return <CodeBody text={view.text} size={view.size} shape={shape} focus={focus} />;
}

function Refused({ message, onGithub }: { message: string; onGithub: string | null }) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="max-w-[44ch] text-center">
        <p className="text-[14px] leading-[1.85] text-said-soft">{message}</p>
        {onGithub ? (
          <a
            href={onGithub}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-4 inline-block text-[13px] font-medium text-lamp underline underline-offset-4"
          >
            GitHub에서 열어보기
          </a>
        ) : null}
      </div>
    </div>
  );
}

function ImageBody({ url, size }: { url: string; size: number | null }) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {/*
          A plain <img>, deliberately. It is the one place a browser refuses to
          run an SVG's script, and it is where every picture here is shown.
          `object-contain` inside a box that owns the space is what stops a
          4000px photo from pushing the popup off the screen.

          eslint-disable-next-line @next/next/no-img-element — this is an object
          URL for bytes we hold for the life of the popup, which the image
          optimiser cannot take and must not cache.
        */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          className="max-h-full max-w-full object-contain"
        />
      </div>
      <p className="shrink-0 px-4 pb-3 text-[11px] text-said-faint">
        {natural ? `${natural.width}×${natural.height}` : "그림"}
        {size !== null ? ` · ${formatBytes(size)}` : ""}
      </p>
    </div>
  );
}

/**
 * The file, with a number beside every line.
 *
 * No colouring. Syntax highlighting is a dependency and a guess about the
 * language, and this reader mostly cannot read the code anyway — what they need
 * is to see that line 42 exists and that it is the one we pointed at. The
 * numbers are what make the map's "42–58줄" mean something.
 */
function CodeBody({
  text,
  size,
  shape,
  focus,
}: {
  text: string;
  size: number | null;
  shape: PreviewShape;
  focus: PreviewFocus | null;
}) {
  const lines = useMemo(() => splitLines(text), [text]);
  const window = useMemo(() => lineWindow(lines.length, focus), [lines.length, focus]);
  const firstFocusRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    // Land on the part that was pointed at, rather than at the top of a file
    // whose interesting line is at 320.
    firstFocusRef.current?.scrollIntoView({ block: "center" });
  }, [text]);

  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-[14px] text-said-soft">{PREVIEW_MESSAGES.empty}</p>
      </div>
    );
  }

  const shown = lines.slice(window.from - 1, window.to);
  const gutter = String(window.to).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {window.clipped ? (
        <p className="shrink-0 border-b border-edge px-4 py-2 text-[12px] leading-[1.7] text-said-soft">
          파일이 길어서 {window.from.toLocaleString("ko-KR")}–
          {window.to.toLocaleString("ko-KR")}줄만 보여 드려요. 전체는{" "}
          {lines.length.toLocaleString("ko-KR")}줄이에요.
        </p>
      ) : null}

      <div
        // Focusable so a keyboard user can scroll a long file with the arrow
        // keys without having to find something clickable inside it first.
        tabIndex={0}
        role="region"
        aria-label="파일 내용"
        className="min-h-0 flex-1 overflow-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-lamp-dim"
      >
        <ol className="min-w-max py-2 font-mono text-[12.5px] leading-[1.7]">
          {shown.map((line, index) => {
            const number = window.from + index;
            const lit =
              focus !== null &&
              number >= focus.startLine &&
              number <= (focus.endLine ?? focus.startLine);
            return (
              <li
                key={number}
                ref={lit && number === focus?.startLine ? firstFocusRef : undefined}
                className={`flex gap-3 px-4 ${lit ? "bg-lamp/10" : ""}`}
              >
                <span
                  aria-hidden
                  style={{ width: `${gutter}ch` }}
                  className={`shrink-0 select-none text-right ${lit ? "text-lamp" : "text-said-faint"}`}
                >
                  {number}
                </span>
                <span className="whitespace-pre text-said-soft">{line || " "}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <p className="shrink-0 border-t border-edge px-4 py-2 text-[11px] text-said-faint">
        {lines.length.toLocaleString("ko-KR")}줄
        {size !== null ? ` · ${formatBytes(size)}` : ""}
        {shape.language ? ` · ${shape.language}` : ""}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- plumbing */

/**
 * A refusal, as the route writes them.
 *
 * Read defensively: a proxy, a sign-in redirect or a runtime error can put
 * something that is not our JSON on the other end of this, and the answer to
 * that is a plain sentence rather than a blank popup.
 */
async function readRefusal(response: Response): Promise<ViewState> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof (body as { message: unknown }).message === "string"
    ) {
      const told = body as { message: string; reason?: unknown };
      const reason =
        typeof told.reason === "string" ? (told.reason as PreviewRefusal) : "github";
      return { state: "refused", reason, message: told.message };
    }
  } catch {
    // Not JSON. Falls through to the generic sentence.
  }
  return { state: "refused", reason: "github", message: PREVIEW_MESSAGES.failed };
}

/** Lines, with Windows endings normalised and a single trailing blank dropped. */
function splitLines(text: string): string[] {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  // "a\nb\n" is two lines, not three. A file that genuinely ends in a blank
  // line is indistinguishable from one that ends in a newline, and every editor
  // makes the same choice.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** What the file actually weighed, not what its characters count to. */
function byteLength(text: string): number | null {
  try {
    return new TextEncoder().encode(text).byteLength;
  } catch {
    return null;
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}
