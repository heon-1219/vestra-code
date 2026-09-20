# 흐름 따라가기 — code flow, narrated

Source: the founder's ask — "Graph traversing 설명, 기능별로 코드 플로우 트래킹(실시간으로 트래킹 및 코드 설명) 기능 만들기."

Status: **Phase 0 built and measured (2026-09-21). Phases 1–5 proposed.**
`src/lib/graph/flow.ts` and `src/lib/graph/flow.test.ts` are the walk, headless: entry
points, both joints, the beam, the lexicographic ranking, the bounds, the five
terminals, the event shape and every refusal sentence. Nothing is on screen yet.
§11.1's call-site line is carried, so `GraphConnection.line` now exists.
The decisions this produced are **D78–D86** in `DECISIONS.md`; the measurements are
§8 below, with the two results that did not come out as this document predicted marked
where they sit.

---

## 0. The one sentence

A user picks a place in their app — 결제, 로그인, `/checkout` — and the product walks the code from there, hop by hop, writing one plain sentence per hop as it goes.

Everything below is either how that walk is computed, who writes the sentences, or what the product says when it cannot.

---

## 1. What it claims, and what it refuses

The founder wrote 실시간으로 트래킹. That phrase has two readings and only one of them is true of this product.

- **Live narration of a static walk.** We computed a path from what a parser recorded, and the explanation appears as we produce it. True today.
- **Runtime tracing.** We instrument the running app and follow a real request. We do not do this. We do not run the user's code at all, anywhere in the product.

The feature claims the first and must never be dressed as the second. This is not fussiness: `view.ts` stops the words 노드 and 엣지 at a boundary, `describe.ts` refuses to turn "we found no connections" into "nothing uses this", `answer.ts` refuses the word 안전, and D68 records a sentence about the founder's own portfolio that was half true and half a claim we could not back. An arrow sliding along a line under the word 추적 would be that failure with animation on top.

So the feature is named **흐름 따라가기**, never 추적, and it says this, once, at the top of its own panel:

> 앱을 실행해 보는 게 아니에요. 코드를 읽어서, 어느 자리가 어느 자리를 부르는지 적어 둔 것뿐이에요.
> 그래서 여기서 보여드리는 건 **실제로 지나간 길이 아니라, 코드가 이어 놓은 길**이에요.

What it refuses to claim, each as a rule with a consequence in the code:

| It never says | Because |
|---|---|
| 이 길로 요청이 지나갔어요 | We never ran anything. No hop may be phrased in the past tense of execution. |
| 이게 이 기능의 전부예요 | It is one path out of many. The branch count is said out loud at every hop. |
| 몇 번 실행됐는지 / 얼마나 걸리는지 | Not measurable without running. Never shown, never implied by a progress-looking element. |
| 조건에 따라 어디로 갈라지는지 | The parser records that A can reach B, not under what condition. |
| 에러가 나면 어디로 가는지 | Same. `catch` blocks are not in the graph. |
| 여기는 건드려도 안전해요 | Already forbidden by `FORBIDDEN_WORDS` in `qa/answer.ts`, and it stays forbidden here. |

The forbidden-word list gains three entries for this feature: **실행**, **추적**, **실시간** — in any product sentence describing a flow. A test asserts they do not come back, the same way D68's sentence has one.

---

## 2. What a flow is, precisely

A flow is a **simple directed path in the graph, from an entry point, along relations that mean "this reaches for that", ending at a terminal we have a sentence for.**

Four things in that sentence are decisions. Each is below.

### 2.1 The joint rule — and the thing that would silently break a naive implementation

This is the detail most likely to make a first attempt return "no path" on a repository that obviously has one, so it comes first.

In `src/analysis/typescript/analyzer.ts`, a page produces **two** nodes for one file:

```
file  --contains-->  route (/checkout)
file  --contains-->  symbol (CheckoutPage)
file  --contains-->  symbol (PayButton)
```

The `route` node is a **sibling** of the page's symbols, not their parent. It has no outgoing `calls`, `renders` or `fetches` edges — those hang off the symbols. A forward-only walk starting at a `route` therefore reaches **nothing**, on every project, forever.

The same shape holds at the other end. A `fetches` edge targets the `api_endpoint` node, which is again a sibling of the handler symbols in the same route file.

So the walk has exactly two sideways moves, and they are named rather than emergent:

- **The entry joint**, taken exactly once, at the start: `route → (its file) → the symbols in that file`.
- **The server joint**, taken exactly once, when the path arrives at an `api_endpoint`: `api_endpoint → (its file) → the symbols in that file`.

Nowhere else does the walk reverse a `contains` edge. `neighbourhood.ts` rule 1 — "a walk never changes direction", because otherwise A and C look connected merely for both touching B — is the reason this is two named exceptions and not a general permission. Both joints are structural facts stated as such in the narration: "이 주소는 이 파일이 맡고 있어요", not "이 주소가 이걸 불러요".

### 2.2 Which relations are hops

| Relation | Role in a flow |
|---|---|
| `renders` | A hop. The screen draws the next thing. |
| `calls` | A hop. |
| `fetches` | A hop, and the most informative one in the picture. |
| `contains` | Never a hop. Used only at the two joints in 2.1. |
| `imports` | Never a hop. It is the same reach at a coarser grain, and admitting it makes everything reach everything — see 2.5. |
| `uses_package` | Never a path member. A package is an **annotation on the hop that uses it** ("이 자리에서는 `stripe`를 써요"), which keeps `react` out of every path while still saying where the project's edge is. |
| `belongs_to` | Never a hop. A grouping we made is not something the code does — `purpose/groups.ts` already draws this line for exactly this reason. |

A consequence worth stating plainly: a project analysed by the **shallow** analyzer has only `imports` and `uses_package`, so it has **no flows at all**. That is a refusal with a sentence (§7), not a degraded flow wearing the same name. D68 is the precedent — a feature that half works must say which half.

### 2.3 Where a flow starts

Ranked by what exists today:

1. **`route` and `api_endpoint` nodes.** These exist in every run of the deep analyzer and need no LLM. A route is the only item kind in the graph a non-developer already understands as a place: `/checkout`, `/login`. On the demo repo that is 1 route and 4 endpoints (recorded in `DECISIONS.md`).
2. **Whatever the user selected.** A file, a symbol, a page. `entryPointsOf(item)` resolves it: a route or endpoint goes through its joint; a file offers its symbols ranked by outgoing behaviour degree; a symbol is itself; a package or feature is refused with a sentence.
3. **What the user typed.** `runBeam` already matches 결제 → `checkout`, `PayButton`, and handles 초성 (`ㄱㅈ`) and wrong-IME (`rufwp`). The flow list is filtered by the same beam that lights the map — not a second search, for the reason `qa/tools.ts` gives about `find_items`.

Considered and deferred: **items with `usedBy === 0`** as probable entry points. Attractive on a repo with no routes, and wrong in a way we could not detect — `usedBy === 0` also means "we failed to resolve the thing that uses it", and `describe.ts` is explicit that we may not turn that into a verdict. Revisit with a measurement, not a hunch.

### 2.4 The walk, and what makes one path "the" flow

There are thousands of paths. We never enumerate them.

**The algorithm is a bounded beam search.** Keep the best `BEAM = 4` partial paths at each depth; expand each by its outgoing behaviour edges; stop at `MAX_HOPS` or when the expansion budget runs out. Cost is `O(BEAM × MAX_HOPS × max out-degree)`, bounded above by a constant. Greedy (beam 1) was the first answer and is wrong: it dead-ends early while a sibling branch reached the endpoint. Full enumeration is exponential and unnecessary.

**Candidate hops are ordered lexicographically, never by a weighted sum.** A weighted sum is where arbitrary constants hide and where a test cannot tell you which criterion fired.

1. **Certainty.** `certain` before `inferred`. A path's certainty is the weakest link on it — `neighbourhood.ts` rule 2, restated, and for the same reason: reporting the last hop or the first would launder a guess into a fact at depth 6.
2. **Does this hop get closer to a server address?** Precomputed once per graph as `distanceToEndpoint`: one reverse BFS from every `api_endpoint` over behaviour edges, `O(V+E)`. This is the criterion that turns wandering into a story, because "주문이 어떻게 되나요" means "where does it leave the screen".
3. **Relation priority**, taken from `RELATION_RANK` in `map/render/scene.ts` — `fetches` (0), `renders` (1), `calls` (3) — **not a second ranking of our own.** Two rankings for one idea is the D69 failure. That order is already right for a flow: the crossing to the server first, then what the screen draws, then the machinery.
4. **Lower `usedBy` on the target.** A helper used in twelve places is shared machinery; a function used in one is this feature's spine. `usedBy` is already computed by `load.ts` under D69's rule, so this is free and consistent with what the panel says.
5. **Id ascending.** So two runs over an unchanged graph produce a byte-identical path — the same promise `layout.ts`, `grouping.ts` and `load.ts` each make.

**Complete paths are then ranked by terminal, then by length ascending.** Terminal order: reached an `api_endpoint` (or continued past it through the server joint) > ended at a leaf > hit the hop bound > stopped at a cycle. A three-hop path to the server beats a nine-hop one that wandered through utilities to get there; a six-hop path that reaches the server beats a one-hop path that dead-ends.

The runner-up paths are already in the beam, so "비슷한 길이 3개 더 있어요" costs nothing.

**Cycles.** A path never visits the same item twice. When the only continuation is back onto the path, the walk stops and says so — and the sentence is one of the more interesting ones the feature produces, because "돌고 도는 구조" is a real fact about the code that the user can act on.

### 2.5 The bounds, and the graph where everything reaches everything

| Bound | Value | Why |
|---|---|---|
| `MAX_FLOW_HOPS` | 12 | `MAX_HOPS` is 6 for the neighbourhood, but that is a *radius* and doubles at every step; a path is one-directional and does not. Twelve is about what fits in a panel and about what a person will read before the story stops being one. |
| `BEAM` | 4 | Enough to survive one bad-looking first hop. Also the source of the "other paths" list, so it is not a separate cost. |
| `MAX_EXPANSIONS` | 400 | A hard stop for a pathological graph, checked rather than assumed. |
| `BRANCHES_SHOWN` | 3, count said out loud | The `hidden` pattern from `neighbourhood.ts`: a list that stops at three with no note reads as "that is all there is", which on this product is a false statement about somebody's code. |

On a graph where everything reaches everything, this returns a path — it has to, that is what it is for — and the honest answer is three things, none of which is the path itself:

1. The branch count at every hop. Nine other ways out of hop 3 is the fact.
2. **The margin.** If the top path's score is not clearly ahead of the second, we say so: "이 길 말고도 비슷하게 그럴듯한 길이 몇 개 있어요." The threshold comes from the distribution measured in §8.4, not from taste.
3. The hop bound, stated: "열두 걸음까지 따라갔는데 아직 끝이 아니에요."

### 2.6 Terminals

Five, each with a sentence (§7): reached a server address; reached a leaf; handed off to an outside tool; hit the hop bound; came back to somewhere it had been.

---

## 3. Where features come from, before Pass 2 has ever run

The founder asked for 기능별로 — 결제, 로그인. `grouping.ts` has the 기능 grouping fully built, including D52's inheritance through `contains`, and it is **unavailable**, because no `feature` row has ever been written: Pass 2 does not exist in `pipeline.ts`. The `semantic` phase and the `feature.created` / `node.assigned` events are declared in `analysis/events.ts` and nothing emits them.

A plan that only works after Pass 2 has a hidden dependency. So:

**Phase 1 names a flow by its route, and says where the name came from.** `/checkout` is 결제 to the person who built it, and the address is a name they recognise, which is the whole reason `KIND_WORDS` calls a route 페이지 rather than a route. The UI line under the name is "이 이름은 주소에서 가져왔어요" — the same move `grouping.ts` makes with `folder: "직접 붙인 이름"` versus `"기능"`.

**When a user has no route** — a static site, a component library — the flow list offers what is selected and nothing else, with the refusal in §7.

**When Pass 2 lands**, a `feature` node becomes a second spine: its entry points are the routes and endpoints that `belongs_to` it, and the walk is unchanged. Nothing in §2 has to be rewritten. Where the flow list has to say that features are not available yet, it uses `grouping.ts`'s own sentence verbatim —

> 기능 이름은 아직 붙이기 전이에요. 이름이 붙으면 여기서 기능별로 볼 수 있어요.

— because the map already says exactly that, and two halves of one screen explaining the same gap two different ways is the failure `grouping.ts` wrote that sentence to avoid.

---

## 4. What each hop says, who writes it, and what it costs

Four layers, and the point of the arrangement is that **a twelve-hop flow costs zero model calls in the warm case and at most one in the cold case.**

### Layer 0 — `describe.ts`. Free, measured, always.

Every item already has a line: "화면 조각이에요, 3곳에서 써요", "`/api/orders` 주소에 답하는 곳이에요". Built from what the parser counted, so it is true before any model has run, true when there is no API key, and true when Pass 2 failed. This is the floor and it is a real one — the product should read as finished without an LLM and better with one.

### Layer 1 — the relation verb. Free.

`RELATION_WORDS[relation]` gives the arrow's words, already resolved at the `view.ts` boundary. Plus the call-site line, where we have it — see §11.1, because we do not currently carry it as far as the client and we should.

Together these two layers already produce the whole hop list with no model anywhere:

```
①  결제 화면                                   확실해요
    /checkout 주소로 열리는 페이지예요
    │  이 주소는 checkout/page.jsx 가 맡고 있어요
②  PayButton                                   확실해요
    화면 조각이에요, 2곳에서 써요
    │  사용해요 · PayButton.jsx 34줄
③  createOrder                                 확실해요
    일 처리예요, 1곳에서 써요
    │  데이터를 받아와요 · 짐작이에요
④  /api/orders                                 짐작이에요
    /api/orders 주소에 답하는 곳이에요
    여기가 끝이에요 — 서버가 받는 곳까지 왔어요
```

(`createOrder`, called from `PayButton`'s click handler, is real — it is the edge D57 recovered on the demo repo.)

### Layer 2 — `purpose/groups.ts`. One sentence per (relation, target), reused everywhere.

This is the layer that answers the founder's own token question, and it is already built and tested with no caller.

`groupByPurpose` collapses every edge sharing a relation and a target into one group. Twelve components calling `formatPrice` is **one** question, and the twelfth gets the same sentence as the first — which matters more for trust than for cost, because a map that words one fact twelve ways is a map nobody believes.

The arithmetic, written out:

- **Per group asked:** the target's line from `itemLine` (~30 tokens), the relation, up to two example sources (~20 tokens). Batched twenty to a call with a ~300-token instruction: **~1,400 input, ~700 output** per call.
- **Per project, once:** `groupsWorthAsking(groups, 60)` → three calls ≈ **4.2k in / 2.1k out ≈ 2원** on `mimo-v2.5` at D45's rates. Cached on the commit sha per D53, so an unchanged repo costs zero by construction.
- **Per flow, warm:** **zero calls.** Every hop's (relation, target) is either answered or falls back to Layer 1.
- **Per flow, cold:** at most twelve groups, so **one batched call** — never twelve. This is the rule the founder's question was really about, and §8.7 enforces it with an assertion rather than with this paragraph.

### Layer 3 — `qa/investigate()`. Expensive, one hop, on demand.

The investigation loop reads source, cites line ranges, and refuses anything it did not read. It is **not** how a flow is narrated. It is what happens when the user taps one hop and asks 여기서 정확히 무슨 일이 있어요 — one question, scoped to one hop, with the whole citation ledger applied.

Cost, from `qa/types.ts`'s own arithmetic: twelve steps land near **40k input / 3k output ≈ 8원**. A purpose sentence is roughly **0.03원**. That is about **250 times**, and it is the entire reason Layer 3 is a button and not a default.

### Where the purpose sentences live

`edges.metadata` is jsonb and already persisted, but a sentence shared by forty edges stored forty times can drift, which is the failure the grouping was built to prevent. Proposal: a small `edge_purposes` table keyed on `(projectId, purposeKey)` carrying the sentence and `textLang` (D2). That is a schema change and belongs in `DECISIONS.md`.

I am not certain it earns its own table — see §12.1.

---

## 5. The event shape, and what 실시간 is allowed to mean

`analysis/events.ts` and `qa/types.ts` already agree on a shape: `{ seq, type, payload }`, payloads small enough to sit in Postgres, never carrying source. The flow uses the same shape, which is the whole reason `qa/types.ts` says it "refuses to invent a shape the transport cannot take".

```ts
export type FlowEventType =
  | "flow.started" | "flow.hop" | "flow.narrated" | "flow.ended" | "flow.refused";

export type FlowEventPayloads = {
  "flow.started": { startId: string; startName: string;
                    startKind: ItemKind; spine: "route" | "selection" | "feature";
                    maxHops: number };
  "flow.hop": { index: number; fromId: string; toId: string;
                relation: ConnectionRelation;
                /** This hop alone. */         certainty: Certainty;
                /** Weakest so far — what the user reads. */ pathCertainty: Certainty;
                /** Call-site line, when we have one. */ line: number | null;
                /** Outside tools used at this hop. Names only. */ packages: string[];
                /** How many other ways out of here. */ branches: number;
                joint: "entry" | "server" | null;
                narrator: "measured" | "purpose" | "model";
                text: string };
  "flow.narrated": { index: number; text: string; narrator: "purpose" | "model" };
  "flow.ended": { reason: "endpoint" | "leaf" | "package" | "bound" | "cycle";
                  hops: number; weakest: Certainty; alternatives: number };
  "flow.refused": { reason: FlowRefusal };
};
```

Three things about this shape are decisions:

- **`narrator` travels on the wire.** The UI has to be able to say who wrote a sentence, exactly as `Description.fromModel` already does. An LLM sentence and an arithmetic sentence look alike and must not read alike.
- **`certainty` and `pathCertainty` are both present, and only `pathCertainty` is shown as the flow's label.** `neighbourhood.ts` carries `hopCertainty` separately for precisely this reason — the map draws each hop on its own merits, the label is the weakest link, and mixing them launders a guess.
- **No source, ever.** Same rule both existing event modules state. A hop carries ids, a line number and one short sentence.

### The transport, and the honest reading of 실시간

`lib/llm/types.ts` says, deliberately: *"NOT here: streaming. Nothing in this product streams a model's answer yet."* So 실시간 cannot mean token streaming without widening an interface the plan has no business widening.

It does not need to. The walk is microseconds; the whole path is known before hop 1 is drawn. So:

- **The default is synchronous.** `traceFlow()` returns the whole trace and takes an optional `FlowEventSink` — the exact shape `investigate()` uses, where "the trace comes back in full whether or not anyone is watching."
- **The UI paces the reveal**, because a path read one hop at a time *is* the feature and a wall of twelve rows is not. But a paced reveal of a computed answer is an animation, so the copy never calls it 실시간. While nothing is being waited for, the UI says nothing about time.
- **SSE only when something is genuinely in flight** — the cold-cache purpose call, or a Layer 3 investigation. Then the existing machinery carries it: `toSseFrame`, `SSE_HEADERS`, heartbeats every 20s (D17), cursor replay on `Last-Event-ID` (D16). No second transport.

What the UI does as each lands:

| Event | The screen |
|---|---|
| `flow.started` | Panel swaps to the flow state; the header names the start; the map dims to the start alone. |
| `flow.hop` | A row appends with its measured sentence; the map draws that link with its order number and re-lights; the camera eases to include the new item — and does not ease under `prefers-reduced-motion`, the rule `district-map.tsx` already follows. |
| `flow.narrated` | The row's sentence is replaced. Until then the row shows the **measured** line, never a spinner: a real answer beats a placeholder for something better. |
| `flow.ended` | The terminal sentence, the one-line certainty summary, and the alternatives affordance. |
| `flow.refused` | One sentence and, where there is one, the action. |

---

## 6. The screen

The constraints are not negotiable and they are all in the code.

**Where it lives: a fourth `PanelMode`.** `mode.ts` says in its own header that "adding a fourth mode is a row in this file", and it is right. 흐름 따라가기 joins 물어보기 / 프롬프트 만들기 / 설명하기 with `needs: "selection"`, and inherits the request box, the model picker, and — the one with teeth — the IME rules: the box is mounted once and only ever moves by layout, because a remounted input eats a half-typed 한글 syllable (UI_DIRECTION §5, warning 2).

```ts
flow: {
  name: "흐름 따라가기",
  promise: "고른 곳에서 코드가 어디로 이어지는지, 한 걸음씩 따라가 드려요.",
  notYet: "고른 곳에서 코드가 어디로 이어지는지 한 걸음씩 따라가 드릴 거예요. 따라가는 건 아직 준비 중이에요.",
  needs: "selection",
}
```

**Discovery when nothing is selected.** `NothingSelectedState` is already the brief's "project overview and a few suggested questions" slot. It gains a block: 따라가 볼 수 있는 흐름 — the project's routes and endpoints, each a 따라가 보기 button. That is where someone who has not clicked anything finds this.

**Not the left panel.** A third tab beside 기능 and 파일 was considered and rejected: the left panel is a list of *places*, and a flow is not a place. UI_DIRECTION §3 is specific about what that panel leads with.

**The map.** A flow is a path, so it lights on the map **and** lists in the panel, and the panel is primary — there is no room for a sentence on a canvas, and the map alone loses the words that are the whole point.

Three renderer facts constrain this:

1. **`Focus` is `{ id, lit: Set<string> }` and `linkStrength` is the min of its two ends.** So a path `A→B→C` where `A→C` also exists would draw the shortcut at full brightness, indistinguishable from the path. `Focus` has to become path-aware: an ordered set of *links*, not only items. This is the one real change in `render/scene.ts` and it is small.
2. **Dimming is 0.3, never 0** (`DIM`, D59), and `itemStrength` takes the weaker of beam and focus rather than their product, because two dimmings compounding to 9% is the map going black. A flow obeys the same rule: everything off the path dims to 0.3, and the flow's links are the bright thing.
3. **The on-path links are exempt from the LOD label budget.** `touchesFocus` already grants exactly this exemption to a selection's own links, for exactly this reason — the user has just asked what this is connected to and the answer is written on the lines. The flow adds one primitive to `paint.ts`: the hop's **order number**, drawn in the gap `drawRelation` already cuts. That number is the thing that turns a lit subgraph into a path you read in order, and it is a few lines.

**One selection, one meaning.** While a flow is showing, the map's focus **is** the flow. `focusOf`'s one-hop lighting does not also apply — "a second, private idea of near would put two neighbourhoods on screen at once with nothing to tell the user which is which" is `scene.ts`'s own warning and it applies here verbatim.

---

## 7. When it cannot answer

Each of these is a sentence a non-developer can act on. They are drafted, not gestured at, because the product's failures are where its honesty is actually spent.

**No entry point anywhere** (the founder's portfolio: 58 file nodes, 57 link edges, zero routes, zero symbols — D68's measurement):

> 이 프로젝트에서는 아직 시작점을 찾지 못했어요. 사람이 여는 주소를 못 찾아서, 어디서부터 따라가야 할지 정할 수가 없어요. 파일을 하나 골라 주시면 거기서부터 따라가 볼게요.

**Entry point found, but no behaviour connections at all** (shallow analyzer — only `imports`):

> 이 프로젝트에서 읽은 연결 57개는 모두 "이 파일이 저 파일을 불러와요"예요. 어느 자리에서 어느 자리로 넘어가는지까지는 아직 읽지 못해서, 순서대로 따라가 드리긴 어려워요.

The number is this project's own, the way `grouping.ts`'s unavailable sentences carry the project's numbers — it is a fact about their site, not an apology from us.

**A start with nothing leaving it:**

> "/checkout"에서 나가는 연결을 못 찾았어요. 이 페이지가 아무 일도 안 한다는 뜻은 아니고, 저희가 읽어서 이어붙이지 못했다는 뜻이에요.

Never 아무것도 안 해요. This is `describe.ts`'s 쓰는 곳을 아직 못 찾았어요 rule, said forward instead of backward.

**Dead-ends at an outside tool:**

> 여기서부터는 밖에서 가져온 도구 `stripe`가 맡아요. 그 안은 읽지 않아서, 여기까지만 보여드릴 수 있어요.

**A cycle:**

> 여기서 아까 지나온 `Cart`로 다시 돌아가요. 같은 자리를 두 번 지나지 않으려고 여기서 멈췄어요. 돌고 도는 구조라는 뜻이에요.

**The hop bound:**

> 열두 걸음까지 따라갔는데 아직 끝이 아니에요. 더 가면 이야기가 너무 길어져서 여기서 끊었어요. 이어서 보시려면 마지막 자리부터 다시 따라가 주세요.

**A wildcard-matched `fetches`** — the case `analysis/typescript/fetches.ts` marks `inferred` when a `${…}` stood in for a segment:

> 여기서 "/api/orders/:id" 주소로 보내는 것 같아요. 주소 가운데가 그때그때 바뀌게 적혀 있어서, 딱 이 주소가 맞다고는 말씀드리지 못해요. 짐작이에요.

And once, at the top of the whole flow, because certainty is the weakest link and not the last one:

> 이 길 네 걸음 중에 한 군데는 짐작이에요.

**Several paths that are equally good:**

> 이 길 말고도 비슷하게 그럴듯한 길이 3개 더 있어요. 아래에서 바꿔 볼 수 있어요.

**No model configured.** The flow still runs; only Layer 2 is missing:

> 지금은 각 자리가 무슨 일을 하는지까지는 못 풀어 드려요. 대신 어디서 어디로 가는지는 그대로 보여드려요.

---

## 8. How we would know it is right

Not "does it look plausible". This repository has a habit of finding its own defects by measurement — D68 found a false sentence by counting 58 files, 57 link edges and zero style rules; D69 found an inflated number by comparing 7 against a measured 6; `lod.ts` found a feature that could never fire by computing a threshold of 6.81 against a ceiling of 6. Each of those was invisible to looking.

1. **Hand-written ground truth on the demo repo.** `heon-1219/coding-interview-prep` has 1 route and 4 API endpoints. Read the repository by hand once, write down the path a person would give for each of those five, and assert the top-ranked path equals it. Five is small enough to do honestly and large enough to catch "plausible but wrong", which is the only failure the rest of these cannot see.
2. **Entry-point coverage.** For every `route` and `api_endpoint`, does any path exist? Report the fraction. If 1 of 5 produces nothing on the demo repo, that is the joint rule (§2.1) being wrong, not the repo being odd.
3. **Endpoint arrival rate.** Of the paths starting at a route, what fraction reach a server address? Measure it **with and without** the `distanceToEndpoint` criterion. If the number does not move, criterion 2 in §2.4 is decoration and comes out.

   **Measured, 2026-09-21, and this rule as written would have deleted a criterion that carries the feature (D81).** On the `shop` fixture through the real parser the number does **not** move — 1 of 2 routes reach a server address with the criterion and 1 of 2 without it, and the chosen paths are byte-identical. The reason is the fixture: its widest behaviour fork is 4 and `BEAM` is 4, so the branch that crosses to the server survives whatever order the candidates came in, and the path ranking then prefers it. **The beam was doing the work, not the criterion.** Measured again on a synthetic fan-out tree — fan-out 2, 3, 4, 5, 6, 8, 12 across depths 2, 3, 4, 6, 8 — the number does not move at fan-out 2 and moves at all 30 combinations from fan-out 3 up. So the criterion stays, and what it buys is now sayable: it makes the arrival rate independent of `BEAM`. The lesson for the rest of §8 is that "the number did not move" is a fact about the fixture until a second fixture has disagreed with it.
4. **Ranking margin.** For each start, the score gap between path 1 and path 2, and the count of complete paths. This sets the "비슷한 길이 여러 개 있어요" threshold from data. A feature whose top path wins by a hair over forty alternatives is not choosing; it is picking, and the user should be told.

   **Measured, 2026-09-21 (D82).** There is no score, so there is no threshold constant: a lexicographic ranking has no scalar to compare, which is most of why it was chosen. The margin is *which criterion separated the top two*, and "close" is when the three a reader can perceive — where it ends, how long it is, how sure we are — all tied. On the `shop` fixture every start is decided by the length, by one hop: complete paths `/` 2, `/checkout` 6, `/api/orders` 2, none close.
5. **Determinism.** Two walks over an unchanged graph produce byte-identical paths and byte-identical event sequences, including the order of the branch lists. Same promise and same test shape as `load.ts`, `layout.ts` and `grouping.ts`.
6. **Three synthetic fixtures for the pathological cases**, because the largest graph anyone here has measured is 68 items: a single 40-node cycle; a 40-deep chain; and a **complete graph of 30 symbols** where everything calls everything. Assert termination, `MAX_EXPANSIONS` respected, the right refusal sentences, and a wall-clock ceiling. The complete graph is the measured answer to "what happens when everything reaches everything" — currently this document only argues it.

   **Measured, 2026-09-21 (D85).** The 40-node cycle and the 40-deep chain each spend exactly 12 expansions and end on the **hop bound** — a 40-node cycle never reaches the cycle terminal, because twelve is less than forty, so the cycle sentence needs a ring shorter than `MAX_FLOW_HOPS` and `flow.test.ts` carries a four-node one for it. The complete graph of 30 spends the expansion budget and stops there: `MAX_EXPANSIONS` is what terminates it, the path it returns is still simple, and a second run returns the identical path.
7. **Narration cost, asserted.** Count real model calls and tokens for a twelve-hop flow. Assert `calls === 0` warm and `calls <= 1` cold. The rule in §4 is then enforced by a number instead of by a paragraph.
8. **The vocabulary test.** No flow sentence, from any layer including the model's, contains 실행 · 추적 · 실시간 · 안전 · 노드 · 엣지. Extends `FORBIDDEN_WORDS`. D68's precedent: "a test asserts the sentence does not come back."

---

## 9. Build order

Each phase is shippable on its own and none of them is a stub.

**Phase 0 — the walk, headless. Built, 2026-09-21.** `src/lib/graph/flow.ts`: pure, no React, no model, no database. Entry points, joints, beam search, ranking, bounds, terminals, cycle rule. Nothing on screen — and every later phase is wrong without it, which is why the measurement comes before the picture.

Shipped with §8.2, §8.3, §8.4, §8.5, §8.6 and §8.8, plus §11.1's call-site line. **§8.1's hand-written ground truth on `heon-1219/coding-interview-prep` is NOT done** — it needs the repository over the network, and Phase 0 asserted the equivalent against the `shop` fixture through the real parser instead. That is a smaller claim than §8.1 makes and it should still be done. §8.7's narration-cost assertion belongs to Phase 3, which is what will have calls to count.

The exported surface the UI reads:

```
traceFlow(graph, { startId, index?, onEvent?, ignore? }) -> FlowTrace
entryPointsOf(graph, itemId) -> EntryPoints        projectEntryPoints(graph) -> GraphItem[]
indexFlowGraph(graph) -> FlowIndex                 (build once, pass back in)
FLOW_NOTICE  FLOW_NO_MODEL_NOTE  FLOW_FORBIDDEN_WORDS  flowSentenceIssues(text)
flowTerminalSentence(terminal, facts)  flowRefusalSentence(refusal, facts)
guessedAddressNote(address)  certaintyNote(hops, guessed)  alternativesNote(others)
branchesNote(branches)
MAX_FLOW_HOPS  BEAM  MAX_EXPANSIONS  BRANCHES_SHOWN  HOP_RELATIONS
HOP_CRITERIA  PATH_CRITERIA
```

Two things Phase 1 and Phase 2 have to know, both of which this document got wrong:

1. **A joint hop has no edge behind it.** `scene.ts` already grew a path-aware `Trail`
   for the Q&A walk, so §11.3 is out of date and Phase 2 is mostly wiring — but a
   `FlowHop` whose `joint` is not null must map to a `TrailStep` with
   `connected: false`. Drawing a line for it would invent a connection the graph does
   not have, which is exactly what `connected` exists to stop.
2. **The flow does not stop at the server address** (D84). It goes through the server
   joint into the handler, so the "여기가 끝이에요 — 서버가 받는 곳까지 왔어요" sentence
   fires only when the joint cannot be taken. The crossing is still findable: it is
   the hop whose target is an `api_endpoint`, and `FlowPath.reachedEndpoint` says it
   happened.

**Phase 1 — the flow, read as a list.** The fourth `PanelMode`, the hop list narrated by Layers 0 and 1 only, the discovery block in the nothing-selected state, every refusal sentence in §7. **Zero LLM, zero schema change.** On the demo repo this already answers "주문이 어디서 이뤄지나요" with a numbered path whose every row opens a file. This is a complete feature.

**Phase 2 — the map lights the path.** Path-aware `Focus`, hop numbers on the on-path links, LOD exemption, the camera walking the path under the existing reduced-motion rule. Same list, now with a picture.

**Phase 3 — purpose sentences.** Wire `purpose/groups.ts` to a model as one batched pass inside the run, store them, cache on the commit sha (D53). Flow hops upgrade from 사용해요 to 여기서 가격을 사람이 읽는 모양으로 바꿔요. Zero extra cost per flow. This also improves **every connection row in the right panel**, not just flows — and it is the first thing that makes `phase.changed → semantic` emit anything, which the panel's checklist has been drawing a step for all along.

**Phase 4 — one hop, investigated.** A 자세히 on a hop calls `investigate()` with a question built from that hop. Citations, line numbers, refusals. Needs the QA HTTP route, which does not exist yet.

**Phase 5 — features as a spine.** When Pass 2 writes `feature` rows, each feature offers its entry points and §2 is unchanged. One new entry rule, no new algorithm, and `grouping.ts`'s 기능 map turns itself on at the same moment with no code change, exactly as it was built to.

---

## 10. Runtime tracing, kept separate

If we ever wanted the *other* reading of 실시간 트래킹, this is what it costs. It is here so nobody reads §9 as leading to it.

- **We would have to run the user's code.** That means `npm install` on an untrusted tree — `postinstall` alone executes arbitrary code from the repository — then a build, then execution.
- **A sandbox.** The brief names E2B for Step 6's stretch. Per-session container, real cold start, real per-minute cost, and a security boundary that has to actually hold.
- **Instrumentation.** Node's inspector protocol or an OTel-style hook, plus a way to map a stack frame back to a `nodes.id`, which means source maps at the same commit the graph was measured against.
- **Driving the app.** A real request needs credentials, a database, and environment variables — precisely what a vibe-coded app is least likely to have in a form we can supply, and what we are least entitled to ask for.
- **And the gain is narrower than it sounds.** It would tell you what one request did, once, under one set of inputs. It would not tell you what the code makes possible — which is the question "결제가 어떻게 되나요" is actually asking.
- **D26's closing note bites hardest here.** For Lovable and Base44 users, much of the app is not in the repository at all: the backend is Supabase configuration and SQL, or a proprietary runtime. Running what *is* in the repository would trace half an app and present it as the whole one — which is a more confident version of exactly the failure D68 caught.

This is a separate product decision, not a later phase of this one, and its vocabulary must not be borrowed forward into §1 on the strength of it maybe existing later.

---

## 11. What in the codebase contradicts or complicates this plan

Found by reading, listed so nobody rediscovers them.

1. ~~**`GraphConnection` carries no line number, and the data exists.**~~ **Fixed 2026-09-21, D83.** `edges.metadata.line` is selected by `load.ts` and lands on `GraphConnection.line`, optional and absent-rather-than-null. Measured on the `shop` fixture: all 16 `calls`/`renders`/`fetches` edges carry one, and nothing else does.
2. **The route/endpoint sibling shape (§2.1).** Stated again here because it is the thing that would silently produce "no path" on a repository that obviously has one.
3. ~~**`linkStrength` lights any link between two lit items.**~~ **Out of date as of 2026-09-21.** `render/scene.ts` has since grown `Trail` / `TrailStep` / `trailOf` / `stepFor` for the Q&A investigation walk: an ordered set of *links*, matched on direction as well as on ends, with `itemStrength` and `linkStrength` already taking a trail. A flow maps onto it directly. **One rule to carry over:** a joint hop has no edge behind it, so it must become a `TrailStep` with `connected: false` — the field exists because drawing a line for a step the graph does not have would invent a connection (D79).
4. **`lib/llm/types.ts` deliberately has no streaming.** So 실시간 cannot mean token streaming, and this plan does not ask for it to.
5. **`purpose/groups.ts` has no caller and no storage.** `groupByPurpose` is exported and tested; nothing in `pipeline.ts` calls it; there is no column or table for the answers. "Built, not yet wired" is exact, and the wiring includes a schema addition.
6. **`analysis/events.ts` declares a `semantic` phase and `feature.created` / `node.assigned` events that nothing emits**, while `panel/states.tsx` draws a 기능 이름 붙이는 중 step for it. Not this feature's bug; Phase 3 is the thing that would finally make that step true.
7. **`mode.ts` states flatly that none of its three modes works — "There is no model wired up behind any of them" — and that is now out of date.** `lib/llm/config.ts` and `client.ts` exist, `qa/loop.ts` is built and tested. A fourth mode added today inherits a `notYet` regime whose premise has changed.
8. **`panel/` and `lib/llm/` were being edited by other agents while this was written** (`connections-panel.tsx`, `model.ts`, `model-select.tsx`, `llm/config.ts`, `llm/client.ts`, `llm/types.ts`). Phase 1 touches `mode.ts` and `states.tsx`. Sequence after that work lands, and prefer a new `panel/flow-state.tsx` over an edit to `states.tsx`.
9. **The demo repo's recorded edge counts predate `fetches`, and they are STILL unmeasured.** `DECISIONS.md` records 22 files / 38 symbols / 4 endpoints / 1 route / 3 packages and 119 edges with no `fetches` (D56 says they did not exist yet); `analyzer.ts` now emits them and D57 took the count to 121. Phase 0 did **not** re-measure it: `heon-1219/coding-interview-prep` needs the network, and the live parser suite that reaches it is skipped by default. §8.1's ground truth is still owed.

   What Phase 0 did measure, so the flow work is not resting on nothing, is `src/analysis/__fixtures__/shop` through the real parser and the real `buildGraphView`: **49 items, 63 connections — 27 `contains`, 15 `imports`, 10 `calls`, 5 `renders`, 5 `uses_package`, 1 `fetches`; 61 certain, 2 inferred.** Widest behaviour fork: 4. Entry points: 3 (`/`, `/checkout`, `/api/orders`), coverage 3 of 3. That fixture is the same tree `analyzer.test.ts` measures, and it is smaller and tamer than the demo repo — §8.3's surprise is exactly what "smaller and tamer" costs.

---

## 12. What I am not sure about

Stated rather than smoothed over.

1. **Whether the (relation, target) purpose key earns its own storage.** For a `calls` edge, the purpose is close to the target's `nodes.summary`, which already exists and which `describe.ts` already prefers. `groups.ts` argues the relation matters — `calls formatPrice` and `renders formatPrice` are different jobs — and that is true in principle. Whether it is true often enough to pay for a table is measurable on the demo repo by generating both and comparing, and it should be measured before the schema changes.
2. **Whether "lower `usedBy` is more likely to be the spine" holds on a real repository.** It is plausible, it is free, and it is untested on anything larger than 68 items. §8.3 and §8.4 are what would settle it, and it should come out if it does not move a number.
3. **The branching factor on a 300-file repo is unknown.** The largest graph measured in this codebase is the demo's 68 items. The complete-graph fixture in §8.6 is a proxy for the hairball case, not an answer about real projects. Until a 300-file repo has actually been walked, `MAX_EXPANSIONS = 400` and `BEAM = 4` are guesses with a stated reason, not measured constants.
4. **Whether a route's address is a good enough 기능 name for the founder's actual ask.** `/checkout` reads as 결제 to the person who built it; `/app/[projectId]` reads as nothing. Phase 1 may be more useful on some projects than others, and I do not know the split without looking at more repos than the two in this document.
5. **Whether the paced reveal survives contact with a user.** It is the honest version of 실시간 and it may simply read as slow. It is a UI setting, not an architecture, so it is cheap to change — but I have not seen it.

---

## 13. Decisions this needs, for `DECISIONS.md`

Listed, not written — `DECISIONS.md` is not edited by this document.

**Phase 0 settled the first seven and eighth of these as D78–D86 (2026-09-21).** Two of
them came out differently from the way they are written below, and both are marked in
place: the `distanceToEndpoint` criterion's justification (§8.3, D81) and the server
joint's effect on where a flow ends (D84). The remaining bullets — path-aware `Focus`,
the SSE rule, purpose storage, runtime tracing — are untouched and still owed.

- **The feature is 흐름 따라가기 and never 추적.** It narrates a path the code makes possible. 실행 · 추적 · 실시간 join `FORBIDDEN_WORDS` for flow sentences, with a test.
- **A flow traverses `renders`, `calls` and `fetches` only.** `imports` is excluded because it makes everything reach everything; `uses_package` is an annotation on a hop, never a path member; `belongs_to` and `contains` are structure.
- **`contains` is reversed at exactly two named joints** — the entry joint at a route, the server joint at an endpoint — and nowhere else.
- **A route is the spine before Pass 2 exists, and the UI says the name came from the address.** Features become a second spine when Pass 2 lands, with no change to the walk.
- **Ranking is lexicographic, not a weighted sum,** and relation priority reuses `RELATION_RANK` from `scene.ts` rather than defining a second order.
- **Bounds: 12 hops, beam 4, 400 expansions, 3 branches shown with the count said out loud.**
- **A twelve-hop flow costs at most one model call.** Enforced by an assertion, not by convention. `investigate()` is per-hop and on demand, at roughly 250× the cost.
- **`GraphConnection` gains the edge's call-site line**, carried from `edges.metadata` through `load.ts` and `view.ts`.
- **`Focus` becomes path-aware** — an ordered set of links, not only item ids — and on-path links are exempt from the LOD label budget and carry a hop number.
- **Flow events reuse the `{ seq, type, payload }` shape**, are delivered by an in-process sink by default, and reach SSE only when a model call is genuinely in flight.
- **Purpose sentences get storage** — `edge_purposes(projectId, purposeKey) → text, textLang` — pending the measurement in §12.1.
- **Runtime tracing is a separate product decision**, with the costs in §10 on the record, and its vocabulary is not borrowed forward.
