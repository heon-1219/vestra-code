import Link from "next/link";

import { HeroGraph } from "@/components/landing/hero-graph";

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
    title: "소스 코드를 보관하지 않습니다",
    body: "지도와 파일 경로, 줄 번호만 남깁니다. 코드는 필요할 때 가져와 읽고 곧바로 버립니다.",
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
   certainty. Light fill because on this page light means "you act here". */
const ACTION =
  "inline-flex h-11 items-center justify-center rounded-lg bg-paper px-6 text-[15px] font-semibold text-ink transition-colors hover:bg-lamp";

export default function LandingPage() {
  return (
    <main className="relative flex flex-col">
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
            <Link href="/sign-in" className={`${ACTION} h-10 px-5 text-[14px]`}>
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
          <div className="mx-auto w-full max-w-[1200px] px-6 md:px-10">
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
              <p className="mt-4 max-w-[500px] text-copy text-said-soft">
                Vestra Code는 프로젝트를 처음부터 끝까지 읽어서, 화면 하나가
                어디에서 만들어지고 그것을 건드리면 또 어디가 움직이는지 한 장의
                지도로 그립니다. 읽는 건 우리가 합니다.
              </p>
              <div className="pointer-events-auto mt-11 flex flex-wrap items-center gap-x-6 gap-y-4">
                <Link href="/sign-in" className={ACTION}>
                  내 프로젝트 연결하기
                </Link>
                <span className="text-micro text-said-faint">
                  GitHub 저장소 또는 내 컴퓨터의 폴더
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Sections are divided by a change of surface and a great deal of empty
          space, not by a rule across the page. */}
      <section className="relative bg-ink-sunk">
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
              <div key={pain.title} className="rise col-span-12 md:col-span-4">
                {/* Mono for the numeral, where mono is actually the right
                    family. It is not used for the Korean labels. */}
                <span className="font-mono text-[13px] text-said-faint">
                  {String(index + 1).padStart(2, "0")}
                </span>
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
          {/* Tight gutters. The cards are a single mosaic, not four separate
              objects with a corridor between them. */}
          <div className="mt-20 grid grid-cols-12 gap-2">
            {FEATURES.map((feature) => (
              <article
                key={feature.title}
                className={`rise col-span-12 ${feature.span} hairline lift rounded-xl bg-ink-raised p-8 hover:-translate-y-0.5 hover:border-edge-lit md:p-10`}
              >
                <span className="label-kr text-micro text-said-faint">
                  {feature.eyebrow}
                </span>
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

      <section className="relative bg-ink-sunk">
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
            {PROMISES.map((promise) => (
              <div
                key={promise.title}
                className="rise rule-t col-span-12 pt-6 sm:col-span-6 lg:col-span-3"
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
          <p className="mt-6 max-w-[420px] text-micro text-said-faint">
            소스 코드는 보관하지 않습니다. 지도와 파일 경로만 남습니다.
          </p>
        </div>
      </footer>
    </main>
  );
}
