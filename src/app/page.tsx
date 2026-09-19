import Link from "next/link";

import { HeroGraph } from "@/components/landing/hero-graph";

const PAINS = [
  {
    title: "이미 있는 걸 또 만들었어요",
    body: "에이전트한테 기능 하나를 부탁했더니, 어딘가에 똑같은 게 이미 있는 줄 모르고 새로 만들어 둡니다. 비슷한 게 세 개가 되고, 어느 게 진짜인지는 아무도 모릅니다.",
  },
  {
    title: "작은 수정이 다른 데를 부쉈어요",
    body: "버튼 색만 바꿨는데 결제 화면이 멈춥니다. 그 버튼이 다른 곳에서도 쓰이고 있었다는 걸, 부서진 다음에 알게 됩니다.",
  },
  {
    title: "내 앱인데 건드리기가 무서워요",
    body: "무엇이 무엇과 이어져 있는지 모르니까, 고치는 게 아니라 도박이 됩니다. 결국 손대지 않는 쪽을 고르게 됩니다.",
  },
];

const FEATURES = [
  {
    eyebrow: "지도",
    title: "앱 전체를 한 장으로 봅니다",
    body: "저장소를 연결하면 코드를 읽어서 지도를 그립니다. 파일 이름이 아니라 결제, 로그인, 장바구니처럼 사람이 쓰는 말로 묶어서 보여줍니다.",
    span: "lg:col-span-3",
  },
  {
    eyebrow: "질문",
    title: "궁금한 걸 그냥 물어보세요",
    body: "“로그인은 어디서 처리되나요?” 답에 붙은 칩을 누르면 지도에서 그 부분이 켜집니다. 모르면 모른다고 답합니다.",
    span: "lg:col-span-2",
  },
  {
    eyebrow: "연결",
    title: "무엇이 같이 바뀌는지 먼저 알려줍니다",
    body: "하나를 고르면 그게 쓰는 것과, 그걸 쓰는 것을 전부 보여줍니다. 확실한 연결은 실선, 짐작은 점선입니다. 안전하다고는 말하지 않고, 아는 연결이 없다고만 말합니다.",
    span: "lg:col-span-2",
  },
  {
    eyebrow: "프롬프트",
    title: "에이전트가 오해할 수 없는 지시를 만듭니다",
    body: "바꾸고 싶은 걸 가리키고, 하고 싶은 말을 평소 말로 적으세요. 어디를 고쳐도 되고 어디는 건드리면 안 되는지까지 적힌 프롬프트가 나옵니다. 복사해서 쓰던 도구에 붙여넣으면 됩니다.",
    span: "lg:col-span-3",
  },
];

export default function LandingPage() {
  return (
    <main className="flex flex-col">
      <header className="fixed inset-x-0 top-0 z-50">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between px-6 py-5">
          <span className="text-[15px] font-semibold tracking-[-0.02em]">
            Vestra Code
          </span>
          <Link
            href="/sign-in"
            className="rounded-full bg-paper px-5 py-2 text-[14px] font-semibold text-ink transition-colors hover:bg-lamp"
          >
            시작하기
          </Link>
        </div>
      </header>

      {/* Hero. Tall enough that the scroll has travel to drive the untangle. */}
      <section className="relative h-[260vh]">
        <HeroGraph />

        <div className="pointer-events-none sticky top-0 flex h-screen items-center">
          <div className="mx-auto w-full max-w-[1180px] px-6">
            <div className="max-w-[760px]">
              <p className="mb-7 text-[13px] font-medium tracking-[0.14em] text-said-faint uppercase">
                Vestra Code
              </p>
              {/* Real text, rendered before the canvas. */}
              <h1 className="display-kr text-[clamp(2.5rem,7vw,5.25rem)] text-said">
                내가 만들었지만,
                <br />
                <span className="text-lamp">내 손을 떠난</span> 프로젝트.
              </h1>
              <p className="mt-8 max-w-[520px] text-[17px] leading-[1.78] text-said-soft">
                AI와 함께 만든 앱이 어느 순간 이해할 수 없는 것이 됩니다. Vestra
                Code는 저장소를 읽어서 앱의 지도를 그리고, 무엇이 무엇과
                이어져 있는지 사람의 말로 알려줍니다.
              </p>
              <div className="pointer-events-auto mt-10 flex flex-wrap items-center gap-3">
                <Link
                  href="/sign-in"
                  className="rounded-full bg-paper px-7 py-3.5 text-[15px] font-semibold text-ink transition-colors hover:bg-lamp"
                >
                  저장소 연결하기
                </Link>
                <span className="text-[14px] text-said-faint">
                  공개 저장소 · 코드는 저장하지 않습니다
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="relative border-t border-edge bg-ink-sunk">
        <div className="mx-auto max-w-[1180px] px-6 py-28">
          <h2 className="display-kr max-w-[640px] text-[clamp(1.75rem,3.6vw,2.75rem)]">
            바이브 코딩이 무너지는 건 언제나 같은 세 지점입니다.
          </h2>
          <div className="mt-16 grid gap-x-10 gap-y-12 md:grid-cols-3">
            {PAINS.map((pain, index) => (
              <div key={pain.title}>
                <span className="font-mono text-[13px] text-lamp-dim">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-3 text-[19px] font-semibold tracking-[-0.02em]">
                  {pain.title}
                </h3>
                <p className="mt-3 text-[15px] leading-[1.8] text-said-soft">
                  {pain.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative border-t border-edge">
        <div className="mx-auto max-w-[1180px] px-6 py-28">
          <h2 className="display-kr max-w-[720px] text-[clamp(1.75rem,3.6vw,2.75rem)]">
            코드를 못 읽어도, 내 앱은 알 수 있어야 합니다.
          </h2>
          <div className="mt-16 grid gap-4 lg:grid-cols-5">
            {FEATURES.map((feature) => (
              <article
                key={feature.title}
                className={`${feature.span} rounded-2xl border border-edge bg-ink-raised p-8 transition-colors hover:border-edge-lit`}
              >
                <span className="font-mono text-[12px] tracking-[0.1em] text-lamp-dim uppercase">
                  {feature.eyebrow}
                </span>
                <h3 className="mt-4 text-[21px] font-semibold tracking-[-0.025em]">
                  {feature.title}
                </h3>
                <p className="mt-3 max-w-[46ch] text-[15px] leading-[1.8] text-said-soft">
                  {feature.body}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="relative border-t border-edge bg-ink-sunk">
        <div className="mx-auto max-w-[1180px] px-6 py-32 text-center">
          <h2 className="display-kr mx-auto max-w-[680px] text-[clamp(2rem,4.5vw,3.5rem)]">
            내 프로젝트를 다시 내 것으로.
          </h2>
          <p className="mx-auto mt-6 max-w-[460px] text-[16px] leading-[1.8] text-said-soft">
            GitHub 공개 저장소를 연결하면 몇 분 안에 지도가 그려집니다.
          </p>
          <Link
            href="/sign-in"
            className="mt-10 inline-block rounded-full bg-paper px-8 py-4 text-[15px] font-semibold text-ink transition-colors hover:bg-lamp"
          >
            시작하기
          </Link>
        </div>
      </section>

      <footer className="border-t border-edge">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-2 px-6 py-10 text-[13px] text-said-faint sm:flex-row sm:items-center sm:justify-between">
          <span>Vestra Code</span>
          <span>
            소스 코드는 저장하지 않습니다. 지도와 파일 경로만 보관합니다.
          </span>
        </div>
      </footer>
    </main>
  );
}
