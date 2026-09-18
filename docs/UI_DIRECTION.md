# UI direction

Source: a 12-agent research round — six survey angles (code tools, futurism, graph
legibility, non-coder products, Korean UI craft, the analysis moment), three
independent art directions, three judges scoring all three through a single lens each.

Status: **proposed, awaiting David.** This resolves O1 in `DECISIONS.md`.

---

## 1. The scores, and why the tie is the answer

| Direction | Non-coder advocate | Design director | Engineer | Total |
|---|---|---|---|---|
| 동네 (Dongne) | 8 | 8 | 4.5 | 20.5 |
| Instrument Grade | 6.5 | 5 | 8.5 | 20 |
| Lamplight (등불) | 5 | 6 | 7 | 18 |

Nothing won. Each direction is strongest exactly where the others are weakest, and
the judges disagreed for stated reasons rather than taste:

- **동네** changes the *object*: at the resting zoom it draws no graph at all — named
  colored districts on paper, with roads between pages. Both the user advocate and the
  design director ranked it first, and for the same reason: it is the only one whose
  default screen is something a non-coder has already read a hundred times, in a mall
  directory or a subway map. The engineer ranked it last: the districts need "streets",
  which needs a Pass 1 parser addition, and convex hulls around feature members can
  interpenetrate into "a Venn diagram of mud".
- **Instrument Grade** is the only direction whose resting state costs zero compute —
  physics off, fixed positions, renders identically every time. The design director
  called it "the least differentiated picture… a beautifully written defence of the 2026
  house style," and found it fails the one word David emphasised: *futuristic*.
- **Lamplight** has the best single mechanism in the round — the beam, where every
  keystroke re-lights the map in the same frame — and is otherwise, in the design
  director's words, "a template with one great mechanism inside it."

## 2. Recommendation

**Build 동네's object, with Lamplight's beam as the mechanism that makes it futuristic,
and Instrument Grade's honesty encoding and build discipline underneath.**

The reasoning is that the three judges were each right about a different axis, and the
axes are separable. 동네 wins the question "what is on screen"; Lamplight wins "what
happens when you act"; Instrument Grade wins "how do we say what we are not sure about,
and what does it cost to run". Taking one direction whole would mean discarding the
answer to two of the three.

**The resting screen** is 동네: no dots. Named districts — 결제, 로그인, 장바구니 — lying flat
on a pale sheet, with the page-to-page links drawn as roads between labelled plates. A
non-coder reads this in ten seconds without being taught anything.

**The interaction** is Lamplight's beam. The input is not a chat box that produces
answers below it; it is a light that falls on the map. Typing dims what is not matched
to 30% — never to zero, so the map never goes black — and lights what is. This is the
"little bit futuristic" the brief asked for, answered with a mechanism rather than a
costume: no glow, no glass, no scanlines, just a map that responds to a sentence inside
one frame. It also solves the search problem for a user who cannot name what they want,
because 초성 matching means typing `ㄱㅈ` finds 결제, and keyboard-layout conversion means
typing `rufwp` with the wrong IME still finds it.

**The honesty layer** is Instrument Grade's, and this is the one place I would override
the design director. The brief's `certain` vs `inferred` distinction is drawn as solid
vs dotted lines — and the research's strongest unsolved complaint is that at the zoom
where a real repo fits on screen, **a 1px dashed stroke and a 1px solid stroke are the
same stroke.** The product's ethical core silently degrades to nothing at exactly the
scale where it matters. A textured hatch survives zoom-out where a dash does not, works
under color-vision deficiency, and survives a projector. Keep it.

## 3. Resolving O1 — David's wireframe vs the brief's

The research settled three of the four conflicts on evidence rather than preference.

**Center panel: live preview or the map?** — *David's wireframe is right, and the brief
is behind the field.* Four teams converged on the same shell within twelve months:
Cursor 2.0, VS Code's Agent Host, Windsurf Wave 10, Zed. Conversation to one side, live
preview in the middle, a reviewable list of what is about to change. Cursor's own stated
reason for the 2.0 redesign was to center on agents rather than files. So the Step 6
iframe is the **convention**, not the stretch. The resolution: build the center as a
frame that holds either, with the same toolbar in the same position, and let the map be
the tenant until the preview exists. The map does not get to claim the center
permanently.

**Left panel: file tree or feature list?** — *Features first; Files as a second tab, as
the brief has it.* Over 63% of vibe-coding users were never programmers, and the tool
most of them learned on is Lovable, which does not show them a file tree. A file tree is
the densest developer-muscle-memory object in the IDE and it names things in a
vocabulary our user does not have. David's instinct — "a design that users are used to"
— is right about the *shell*, and the research agrees the shell should read as a serious
tool; it is wrong about the *tree* specifically. Keeping Files as a visible second tab
costs nothing and preserves the familiarity he wanted.

**Version control panel (center-bottom in David's wireframe)** — stays out. Section 4
puts change timeline, undo and branching out of scope explicitly. The bottom strip
remains the visual placeholder the brief specifies. Not a research question; a scope one
already answered.

**Graph as a permanent full-height right panel** — no, and this is the one the research
is most emphatic about. Section 1 requires the raw graph to be an opt-in tab rather than
the default, and every graph-legibility finding points the same way: the unmediated
node-link view is the thing that makes a frightened person feel worse. It stays a tab.

## 4. What the research says to build in the analysis screen

The brief asks for a "live activity log" beside the graph in Step 3. **A scrolling list
of filenames is a terminal, and a terminal is the most alienating object in a developer
tool for this user.** Ship instead a four-to-six line Korean phase checklist with
counters and checkmarks — 파일 읽는 중 · 구조 파악 중 · 기능 이름 붙이는 중 · 연결 정리 중 — and put the
file-by-file log behind a collapsed 자세히 row. Identical information, opposite emotional
register. The checklist also has a visible end, which a log does not.

## 5. Engineering warnings that must be carried, not rediscovered

These came from the engineer judge and each one inverts something a direction claimed.

1. **The hatch pattern bug.** A `CanvasPattern` fills in the current transform space, so
   under react-force-graph's zoom transform the hatch pitch scales with `globalScale` —
   which destroys the exact property (survives zoom-out) that justified choosing it over
   a dashed line. The pattern must be built against the inverse transform, or drawn in
   screen space. Verify this on a real repo before committing to the encoding.
2. **The migrating input bar does not work as specified.** Moving a React component to a
   different parent unmounts and remounts it: new DOM node, lost focus, lost caret — and
   for us, **lost IME composition state**, which for a Korean-first product means the
   user loses a half-typed 한글 syllable. If the bar moves, it must move by layout, never
   by reparenting.
3. **District hulls can interpenetrate.** d3-force gives no guarantee that a feature's
   members are spatially contiguous; a helper used by three features settles between all
   three. Mitigations: assign each shared node exactly one home district by highest-weight
   `belongs_to`, drop the outermost 10% of members from the hull, and fall back to a
   tinted circle per feature when hull overlap exceeds a threshold. **Prototype this
   against David's real repo in week one** — the fixture project will not have enough
   shared components to expose it, and the demo repo will.
4. **Districts need streets, and streets need a parser change.** Page-to-page links come
   from harvesting `Link href` and `router.push` literals in Pass 1. This is a Step 2
   item that a Step 3 design depends on — sequence it accordingly.

## 6. Korean-first type, as decided

Not a translation problem. Korean needs different metrics than the Tailwind defaults,
and the UI is full of Latin code identifiers (`formatPrice`, `checkout/page.tsx`) that
will sit inside Korean sentences. Decisions: a variable Korean face licensed for
commercial use as the body face, code identifiers given their own visual treatment
rather than inheriting the sentence's face, negative tracking on Korean body text, and
line-height above the Latin default. The register is **해요체** throughout — the user is
anxious and a formal 합니다체 reads as institutional. Concrete token values land with the
first component, not in this document.

---

## Open question for David

The three-way blend above is my recommendation, not a decision. The one thing I would
ask before building: **동네 costs the most and is the most likely to fail on your actual
repo** (the hull-overlap risk). It is also the only direction two of three judges ranked
first. If you want the safer picture, Instrument Grade ships faster and will not embarrass
itself on stage — but the design director's verdict on it was that it looks like every
other 2026 developer tool, which is the one thing you said you did not want.
