import Link from "next/link";
import { redirect } from "next/navigation";

import { Aurora } from "@/components/ambient/aurora";
import { SignInButtons } from "@/components/auth/sign-in-buttons";
import { getSession } from "@/lib/session";

export const metadata = { title: "시작하기 — Vestra Code" };

/**
 * The sign-in page, and the one thing it has to get right: it is the second
 * screen of the landing page, not the first screen of the app.
 *
 * Every link into it comes from the landing page, so it should look like the
 * page it was pressed from. Three things were quietly saying otherwise, and
 * each is fixed below rather than decorated over: the wordmark moved between
 * the two pages, sideways and down; the heading was set in the workspace's
 * display voice rather than the landing's; and the form sat on the aurora
 * with no ground under it.
 *
 * Nothing here says anything new. Every sentence is the one that was already
 * on the page.
 */
export default async function SignInPage() {
  const session = await getSession();
  if (session) {
    redirect("/app");
  }

  return (
    /*
     * `100dvh`, not `100vh`. On a phone the two differ by the height of the
     * browser's own chrome, and with `min-h-screen` the centred block jumped
     * by that much the moment the address bar collapsed — on the one screen
     * whose whole content is a target the visitor is trying to press.
     */
    <main className="relative flex min-h-[100dvh] flex-col">
      <Aurora />

      {/*
        The ground under the form.

        The provider buttons are `ink-raised`, a warm near-black, and the sky
        here is at full strength: unmediated, two dark rectangles on a violet
        wash read as holes punched in the page rather than as the two things
        you are meant to press. This settles the middle of the screen back
        toward the ink the buttons were drawn against, and leaves the corners
        lit so the page is still standing in the same weather as the one
        before it. Centred on the column rather than run across the whole
        page, because the column is the only thing here.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(110% 62% at 50% 52%, color-mix(in oklab, var(--color-ink) 82%, transparent) 0%, color-mix(in oklab, var(--color-ink) 62%, transparent) 42%, transparent 78%)",
        }}
      />

      {/*
        Identical container to the landing page's header — 1200, `px-6
        md:px-10`, `py-5` — so the wordmark does not move when the page does.
        It was 1180 and `px-6` at every width, which put it 10 to 16px to the
        left of where it had just been, and a wordmark that shifts on
        navigation is the one animation nobody asks for.
      */}
      <div className="relative mx-auto w-full max-w-[1200px] px-6 py-5 md:px-10">
        {/* The 40px row is the landing header's button height, which is what
            sets that row's height and therefore where the wordmark's baseline
            lands in it. Without it the mark is 4px higher here than it was one
            click ago, on both pages' first line. */}
        <div className="flex h-10 items-center">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center text-[15px] font-semibold tracking-[-0.02em] text-said-soft transition-colors hover:text-said md:min-h-0"
          >
            Vestra Code
          </Link>
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-[420px]">
          {/*
            `display-hero`, not `display-kr`. Weight 600 against 800, and the
            page's own type scale rather than a pixel literal. `display-kr` is
            the workspace's voice and it is right at 21-32px inside a tool;
            arriving from a landing page that holds every heading at 600, an
            800 title reads as a different product's header. This is still the
            marketing side of the door.
          */}
          <h1 className="display-hero text-section">시작하기</h1>
          <p className="mt-4 text-lede text-said-soft">
            GitHub이나 Google 계정으로 들어오세요. 따로 가입할 것은 없습니다.
          </p>

          <div className="mt-10">
            <SignInButtons />
          </div>

          {/*
            A hairline and the page's own micro size, so this reads as a
            footnote to the two buttons rather than as a third paragraph
            competing with the lede. `said-soft` rather than `said-faint`: it
            is 13px and it is the sentence that tells someone what permission
            we will not ask for, which is the worst sentence on the page to
            set below AA. `said-faint` measures 3.6:1 against the ink, and the
            token wants raising; until it is, a sentence like this one does not
            wait in the quiet tier.
          */}
          <p className="rule-t mt-10 pt-6 text-micro text-said-soft">
            GitHub으로 들어오시면 공개 저장소를 더 빠르게 읽을 수 있습니다.
            비공개 저장소 권한은 요청하지 않습니다.
          </p>
        </div>
      </div>
    </main>
  );
}
