import Link from "next/link";

import { Aurora } from "@/components/ambient/aurora";
import { FeatureMark } from "@/components/landing/feature-mark";
import { HeroGraph } from "@/components/landing/hero-graph";
import { PainMark } from "@/components/landing/pain-mark";
import { RepoToMap } from "@/components/landing/repo-to-map";
import { WaysIn } from "@/components/landing/ways-in";

/**
 * The landing page.
 *
 * Structure is borrowed from the class of page that states one sentence on an
 * empty ground and then earns it: one enormous headline with nothing beside
 * it, a strict twelve-column spine underneath, sections divided by silence and
 * a change of surface rather than by rules, and a type scale with a hole in
 * the middle so nothing drifts toward the centre. Weight is held at 600 and
 * the accent colour is spent entirely on the map behind the headline — the
 * chrome gets none, because a page where everything is emphasised has no
 * emphasis.
 *
 * This is a Server Component with no client boundary of its own, which is what
 * makes the headline real text in the first HTML response. Only `HeroGraph`
 * crosses into the client, and it decides for itself whether to fetch three.js.
 */

/**
 * Three pains, written to one shape: a concrete scene in the first sentence,
 * then a short flat sentence that names what it cost. The reference does this
 * everywhere — a long clause followed by a four-word one — and it is what
 * keeps a list of complaints from reading as a list of complaints.
 */
const PAINS = [
  {
    title: "이미 있는 걸 또 만들었어요",
    body: "기능 하나를 부탁하면, 에이전트는 어딘가에 이미 있는 줄 모르고 새로 만들어 둡니다. 비슷한 게 세 개가 됩니다. 어느 게 진짜인지는 아무도 모릅니다.",
  },
  {
    title: "작은 수정이 다른 데를 부쉈어요",
    body: "버튼 색 하나를 바꿨는데 결제 화면이 멈춥니다. 그 버튼이 다른 화면에서도 쓰이고 있었기 때문입니다. 부서진 다음에 알게 됩니다.",
  },
  {
    title: "내 앱인데 건드리기가 무서워요",
    body: "무엇이 무엇과 이어져 있는지 모르면, 고치는 일은 도박이 됩니다. 그래서 손대지 않게 됩니다.",
  },
];

/**
 * The four from the brief, in the order a person meets them: see the app, ask
 * about it, point at a part of it, hand the result to your agent.
 *
 * All four titles are built to one grammar — [목적어]를 [동사]합니다 — so the set
 * reads as one capability rather than four features. The reference runs eleven
 * customer lines through a single participle construction for exactly this
 * reason: the parallelism does the persuading, not any one line.
 *
 * The spans are 7/5, 5/7 on the twelve-column grid, an asymmetry that reads as
 * composed rather than as four equal boxes.
 */
const FEATURES = [
  {
    eyebrow: "지도",
    title: "앱 전체를 한 장의 지도로 봅니다",
    body: "결제, 로그인, 장바구니처럼 사람이 쓰는 말로 묶어서 그립니다. 파일 이름을 몰라도 읽을 수 있습니다.",
    span: "lg:col-span-7",
  },
  {
    eyebrow: "질문",
    title: "궁금한 것을 평소 말로 물어봅니다",
    body: "“로그인은 어디서 처리되나요?” 답에 붙은 칩을 누르면 지도에서 그 자리가 켜집니다.",
    span: "lg:col-span-5",
  },
  {
    eyebrow: "연결",
    title: "무엇이 같이 바뀌는지를 먼저 봅니다",
    body: "하나를 고르면 그것이 쓰는 것과 그것을 쓰는 것이 함께 나옵니다. 고치기 전에 보입니다.",
    span: "lg:col-span-5",
  },
  {
    eyebrow: "프롬프트",
    title: "오해할 수 없는 지시를 에이전트에게 건넵니다",
    body: "바꾸고 싶은 자리를 가리키고 하고 싶은 말을 평소 말로 적으면, 어디를 고쳐도 되고 어디는 건드리면 안 되는지까지 적힌 프롬프트가 나옵니다. 복사해서 쓰던 도구에 붙여넣으면 됩니다.",
    span: "lg:col-span-7",
  },
];

/**
 * This band sits where the reference puts its customer logos and its "90% of
 * the world's model builders" line. We have no customers, no metrics and no
 * testimonials, and inventing any of them is out of the question. What we do
 * have is a set of things the product refuses to do, each one decided and
 * enforced in the codebase — which for a reader who is already nervous about
 * their own project is worth more than a row of logos anyway.
 */
const PROMISES = [
  {
    /*
     * The one item here that is not an unconditional refusal, so it is the one
     * that has to carry its own condition — and after today it is the only
     * place that carries it at all.
     *
     * A comparison table beside this band said the same two things in these
     * exact words, so this body was cut to its first sentence to stop a reader
     * meeting them twice within one eyeful. The table has since been removed,
     * and the cut was the half of that pairing that would have quietly
     * survived it: the page would have gone on claiming we keep nothing while
     * uploads keep their files (D77). Restored on purpose.
     *
     * The title stays scoped to GitHub, because an uploaded folder has no
     * origin to fetch back from and the flat version of this claim is false for
     * half the product — a false sentence about someone's own code is the worst
     * thing this band could contain.
     */
    title: "GitHub 저장소의 코드는 보관하지 않습니다",
    body: "지도와 파일 경로, 줄 번호만 남깁니다. 코드는 필요할 때 GitHub에서 가져와 읽고 곧바로 버립니다. 내 컴퓨터에서 올려주신 폴더는 다시 가져올 곳이 없어서, 다른 컴퓨터에서도 열어보실 수 있게 파일을 함께 보관합니다.",
  },
  {
    title: "확인한 것과 짐작한 것을 섞지 않습니다",
    body: "코드에서 분명하게 확인되는 연결과 정황으로 짐작한 연결은 지도에서 다르게 그립니다. 어느 쪽인지 언제나 보입니다.",
  },
  {
    title: "모르는 것을 지어내지 않습니다",
    body: "근거를 찾지 못하면 모른다고 답합니다. 답에는 어디를 보고 한 말인지가 함께 붙습니다.",
  },
  {
    title: "“고쳐도 괜찮다”고 말하지 않습니다",
    body: "우리가 아는 연결이 없다고만 말합니다. 우리가 보지 못한 연결은 언제든 있을 수 있으니까요.",
  },
];

/* One action, one shape, used everywhere. Small radius rather than a pill: a
   pill is friendly and a rectangle is certain, and this product's promise is
   certainty. Light fill because on this page light means "you act here".

   `active:` gives it a floor to press against. The button had a hover colour
   and nothing at all on the press, which on a touch screen — where hover does
   not exist — meant the one action on the page answered a tap with nothing
   until the next route painted. One pixel is enough to feel. No transition on
   the way down on purpose: a press that eases is a press that lags. */
const ACTION_BASE =
  "inline-flex items-center justify-center rounded-lg bg-paper font-semibold text-ink transition-colors hover:bg-lamp active:translate-y-px";

const ACTION = `${ACTION_BASE} h-11 px-6 text-[15px]`;

/**
 * The nav's smaller version of the same button, and the reason it is a
 * separate string rather than three extra classes on the end of `ACTION`.
 *
 * It WAS three extra classes — `${ACTION} h-10 px-5 text-[14px]` — and none of
 * the three did anything. Tailwind emits its utilities in its own order, not
 * in the order they appear in a `class` attribute, and `h-11`, `px-6` and
 * `text-[15px]` all sort after their smaller siblings, so every one of them
 * won. Measured: the nav button rendered at 44px tall with 15px type and 24px
 * of padding, pixel for pixel the hero's primary action.
 *
 * The cost of that is not a rounding error, it is the page's hierarchy. The
 * hero holds one action and one sentence about what to hand over; with an
 * identical button sitting above it in the corner, the first screen asked the
 * same question twice at the same volume. One size per role, composed rather
 * than overridden, so the cascade has nothing to decide.
 */
const ACTION_SMALL = `${ACTION_BASE} h-10 px-5 text-[14px]`;

/**
 * The recessed bands, with their edges given back.
 *
 * The intent recorded below is that sections are divided by a change of
 * surface and by silence, "not by a rule across the page". A flat
 * `bg-ink-sunk/70` over a fixed sky delivered the opposite: the sky is
 * always violet and the band is nearly opaque, so the top and bottom of every
 * recessed section resolved into a hard horizontal edge running the full
 * width — a rule across the page, drawn 100% wide, that nobody drew.
 *
 * The same surface with the first and last 160px ramped in reads as a change
 * of light instead of a taped edge, which is what "a change of surface" was
 * supposed to mean. 160px because the bands carry 112 to 160px of padding
 * before their first word, so the ramp finishes in the silence above the
 * heading and never touches type.
 */
const SUNK_BAND: React.CSSProperties = {
  background:
    "linear-gradient(to bottom, transparent 0, color-mix(in oklab, var(--color-ink-sunk) 72%, transparent) 160px, color-mix(in oklab, var(--color-ink-sunk) 72%, transparent) calc(100% - 160px), transparent 100%)",
};

/**
 * The entrance, offset by reading order.
 *
 * `.rise` is a scroll-driven animation on a `view()` timeline, so every item
 * in a row shares one range and the whole row therefore arrives in the same
 * instant — three cards and four cards appearing as one block, which reads as
 * a section popping rather than as a section being read. Pushing each item's
 * range six percent further into the scroll makes them arrive in the order the
 * eye already takes them, left to right, over about a fifth of a screen.
 *
 * Written as an inline `animation-range` rather than a utility class on
 * purpose. `.rise` lives outside any cascade layer in `globals.css`, and
 * unlayered rules beat every layered utility no matter how specific, so a
 * Tailwind class here would be silently ignored. It is also why this is a
 * range and not a delay: a scroll-driven animation has no clock to delay.
 *
 * Nothing needs a reduced-motion guard. `.rise` only declares an animation
 * inside `@media (prefers-reduced-motion: no-preference)`, so when a visitor
 * has asked for less there is no animation for this range to describe and the
 * property does nothing at all — likewise in any browser without `view()`.
 */
function stagger(index: number): React.CSSProperties {
  const start = 10 + index * 6;
  return { animationRange: `entry ${start}% cover ${start + 18}%` };
}

export default function LandingPage() {
  return (
    <main className="relative flex flex-col">
      {/* One sky for the whole document, fixed so it does not scroll away
          after the first screen. */}
      <Aurora />

      {/*
        Absolute rather than fixed, so the header leaves with the hero. A
        persistent transparent bar over a page of large Korean headings puts a
        wordmark on top of a heading at some scroll position on every screen
        size, and the fixes for that — a scrim, a blur, a bar that appears on
        scroll — all add chrome that competes with the one action on the page.
        The action returns, full size, at the end.
      */}
      <header className="absolute inset-x-0 top-0 z-50">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-5 md:px-10">
          <span className="text-[15px] font-semibold tracking-[-0.02em]">
            Vestra Code
          </span>
          <nav className="flex items-center gap-6">
            <Link
              href="/sign-in"
              className="text-[14px] text-said-soft transition-colors hover:text-said"
            >
              로그인
            </Link>
            <Link href="/sign-in" className={ACTION_SMALL}>
              시작하기
            </Link>
          </nav>
        </div>
      </header>

      {/*
        The hero is tall so the scroll has travel to drive the untangle — but
        only where there is something to untangle. Below 900px `hero-graph`
        renders the still instead and never loads the scene, so the extra
        height would be a long scroll past a static picture.
      */}
      <section className="relative h-[140vh] scene:h-[260vh]">
        <HeroGraph />

        <div className="pointer-events-none sticky top-0 flex h-screen items-center">
          {/*
            A band under the nav, and nothing else.

            The graph's own mask already clears the reading column, so the
            words need no panel — but the nav sits at the top RIGHT, which is
            the one part of the screen the mask deliberately leaves at full
            strength, and 14px of `said-soft` over lit links is the thinnest
            thing on the page laid over the busiest. Sixteen percent of the
            viewport, fading to nothing, is enough to seat it. Kept light so
            the crown light still reads through: this paints above the sky as
            well as above the canvas, and the aurora's bright core is up here.
          */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[16vh]"
            style={{
              background:
                "linear-gradient(to bottom, color-mix(in oklab, var(--color-ink) 62%, transparent) 0%, color-mix(in oklab, var(--color-ink) 30%, transparent) 46%, transparent 100%)",
            }}
          />

          <div className="relative mx-auto w-full max-w-[1200px] px-6 md:px-10">
            <div className="max-w-[820px]">
              {/*
                No eyebrow. The wordmark is already in the nav two inches above
                this, and the sentence is stronger arriving alone.

                Real text, in the first response, before the canvas exists. The
                two halves are separated by brightness rather than by hue: the
                line turns on "하지만", and giving the turn a colour would spend
                the one accent on chrome when it belongs to the map.
              */}
              <h1 className="display-hero text-hero text-said-soft">
                내가 만들었지만,
                <br />
                <span className="text-said">내 손을 떠난 프로젝트.</span>
              </h1>
              {/*
                The reference's second move, in its shape: a flat refusal
                first, at the larger size, and the mechanism underneath at the
                smaller one. It refuses the easy promise ("reliable AI has no
                shortcuts") before it says what it does, and closes on a very
                short sentence after a long one. Ours refuses the answer this
                user has been given everywhere else — go and learn to read it.
              */}
              <p className="mt-9 max-w-[520px] text-lede text-said">
                코드를 읽는 법부터 배우라고 하지 않습니다.
              </p>
              {/* Same measure as the lede above it. The two were 520 and 500,
                  which is not a difference anyone chose — it is a difference
                  that shows up as two ragged right edges 20px apart under a
                  headline whose whole authority comes from alignment. */}
              <p className="mt-4 max-w-[520px] text-copy text-said-soft">
                Vestra Code는 프로젝트를 처음부터 끝까지 읽어서, 화면 하나가
                어디에서 만들어지고 그것을 건드리면 또 어디가 움직이는지 한 장의
                지도로 그립니다. 읽는 건 우리가 합니다.
              </p>
              <div className="pointer-events-auto mt-11 flex flex-wrap items-center gap-x-6 gap-y-4">
                <Link href="/sign-in" className={ACTION}>
                  내 프로젝트 연결하기
                </Link>
                {/* `said-soft`, not `said-faint`. This is 13px sitting over a
                    canvas that is still lit here, and `said-faint` measures
                    3.6:1 against the ink even with nothing behind it — under
                    AA for text this size before the graph is considered. The
                    quiet tier is the right intent and the wrong value: the
                    token itself wants raising, and until it is, the places
                    that carry a fact rather than a flourish take the tier
                    above it. */}
                <span className="text-micro text-said-soft">
                  GitHub 저장소 또는 내 컴퓨터의 폴더
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Sections are divided by a change of surface and a great deal of empty
          space, not by a rule across the page. */}
      <section className="relative" style={SUNK_BAND}>
        <div className="mx-auto max-w-[1200px] px-6 py-28 md:px-10 md:py-40">
          <h2 className="rise display-section max-w-[680px] text-section">
            바이브 코딩이 무너지는 건 언제나 같은 세 지점입니다.
          </h2>
          {/*
            The gutter is responsive because the column count is not. Twelve
            columns with a 32px gutter need 352px of gutter before a single
            column of content exists, which is wider than the 327px content box
            at 375px — the tracks collapse to zero and the grid overflows its
            parent. `overflow-x: clip` hides that rather than fixing it (D61),
            so the gutter stays small until there is room for it.
          */}
          <div className="mt-20 grid grid-cols-12 gap-x-2 gap-y-14 sm:gap-x-6 md:gap-x-8">
            {PAINS.map((pain, index) => (
              <div
                key={pain.title}
                className="rise col-span-12 md:col-span-4"
                style={stagger(index)}
              >
                {/* The colour is on the row, not on either half of it: the mark
                    draws in `currentColor`, and a colour written twice is a
                    colour that will eventually be written differently twice.
                    Mono for the numeral, where mono is actually the right
                    family. It is not used for the Korean labels. */}
                <div className="flex items-center gap-3 text-said-faint">
                  <PainMark index={index} />
                  <span className="font-mono text-[13px]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-4 text-[19px] font-semibold tracking-[-0.022em]">
                  {pain.title}
                </h3>
                <p className="mt-3 text-copy text-said-soft">{pain.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative">
        <div className="mx-auto max-w-[1200px] px-6 py-28 md:px-10 md:py-40">
          {/*
            Absolute headline, checkable subline — the reference's most useful
            trick. It claims "the standard every frontier model is measured
            against" and then immediately narrows it to the version you could
            go and verify. A claim with its own evidence attached reads as
            confidence; the same claim alone reads as marketing.
          */}
          <h2 className="rise display-section max-w-[760px] text-section">
            코드를 못 읽어도 내 앱은 알 수 있습니다.
          </h2>
          <p className="rise mt-6 max-w-[460px] text-lede text-said-soft">
            GitHub 저장소를 고르거나 폴더를 올리면, 몇 분 뒤에 지도 한 장이
            나옵니다.
          </p>
          {/*
            The lede above is now the caption for the two drawings under it, in
            its own order: what you hand over, then what comes back. `WaysIn`
            sits directly beneath it because it is the sentence's own correction
            — "고르거나 … 올리면" is two doors and there are three, and a visitor
            whose project was never pushed anywhere is exactly the reader who
            stops at that sentence. `RepoToMap` then does the part no paragraph
            on this page can do for a reader who cannot read code: show that a
            file list and a map are the same project.
          */}
          <WaysIn className="rise mt-14" />
          <RepoToMap className="rise mt-20" />
          {/* Tight gutters. The cards are a single mosaic, not four separate
              objects with a corridor between them. */}
          <div className="mt-20 grid grid-cols-12 gap-2">
            {FEATURES.map((feature, index) => (
              <article
                key={feature.title}
                className={`rise col-span-12 ${feature.span} hairline lift rounded-xl bg-ink-raised p-8 hover:-translate-y-0.5 hover:border-edge-lit md:p-10`}
                style={stagger(index)}
              >
                {/* Colour on the row for the same reason as the numbered band
                    above: the mark is `currentColor`, so there is one place to
                    change it and the two cannot drift apart. */}
                <div className="flex items-center gap-3 text-said-faint">
                  <FeatureMark name={feature.eyebrow} />
                  <span className="label-kr text-micro">{feature.eyebrow}</span>
                </div>
                <h3 className="display-section mt-5 max-w-[24ch] text-card">
                  {feature.title}
                </h3>
                <p className="mt-4 max-w-[44ch] text-copy text-said-soft">
                  {feature.body}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="relative" style={SUNK_BAND}>
        <div className="mx-auto max-w-[1200px] px-6 py-28 md:px-10 md:py-40">
          <h2 className="rise display-section max-w-[680px] text-section">
            우리가 하지 않는 것.
          </h2>
          <p className="rise mt-6 max-w-[480px] text-lede text-said-soft">
            아직 보여드릴 사용자도, 숫자도 없습니다. 대신 이 제품이 지키기로 한
            것을 적어 둡니다.
          </p>
          {/* A ruled band rather than four boxes: this is a specification, and
              it should read like one. */}
          <div className="mt-20 grid grid-cols-12 gap-x-2 gap-y-12 sm:gap-x-6 md:gap-x-8">
            {PROMISES.map((promise, index) => (
              <div
                key={promise.title}
                className="rise rule-t col-span-12 pt-6 sm:col-span-6 lg:col-span-3"
                style={stagger(index)}
              >
                <h3 className="text-[16px] font-semibold tracking-[-0.022em]">
                  {promise.title}
                </h3>
                <p className="mt-3 text-copy text-said-soft">{promise.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative">
        <div className="mx-auto max-w-[1200px] px-6 py-32 text-center md:px-10 md:py-48">
          <h2 className="rise display-hero mx-auto max-w-[720px] text-closing">
            내 프로젝트를 다시 내 것으로.
          </h2>
          {/* Balanced because it is centred: an unbalanced centred paragraph
              leaves a one-word last line sitting under a wide block. */}
          <p className="rise mx-auto mt-7 max-w-[460px] text-lede text-balance text-said-soft">
            지금 연결하면, 내가 만든 앱이 어떻게 생겼는지 오늘 안에 보게 됩니다.
          </p>
          <div className="rise mt-12">
            <Link href="/sign-in" className={ACTION}>
              시작하기
            </Link>
          </div>
        </div>
      </section>

      <footer className="rule-t bg-ink-sunk">
        <div className="mx-auto max-w-[1200px] px-6 py-16 md:px-10 md:py-20">
          {/* The wordmark set large and quiet, which is the one thing a footer
              can say that is entirely true. */}
          <span className="block text-[clamp(1.75rem,3.6vw,2.5rem)] font-semibold tracking-[-0.03em] text-said-faint">
            Vestra Code
          </span>
          {/* The short version of the band above, and it has to carry the same
              split: a one-line "보관하지 않습니다" here would be the last thing a
              reader sees and the one sentence they would remember, which makes
              it the worst place to leave the simpler, no-longer-true version. */}
          <p className="mt-6 max-w-[420px] text-micro text-said-faint">
            GitHub 저장소의 코드는 보관하지 않고, 지도와 파일 경로만 남깁니다.
            올려주신 폴더는 나중에 열어보실 수 있게 파일까지 보관합니다.
          </p>
        </div>
      </footer>
    </main>
  );
}
