/**
 * Aurora: light in a dark room, not a second accent colour.
 *
 * The product was one flat black and read austere rather than calm. This puts
 * atmosphere behind the whole site — but atmosphere only. The palette has
 * exactly one accent, the lamp amber, and it means "you act here"; if violet
 * started carrying meaning too, every button would have to compete with the
 * sky. So the aurora never touches an interactive element, never paints above
 * content, and stays far below the contrast at which it could be mistaken for
 * something to act on.
 *
 * **Two lights on a diagonal.** One upper left, one lower right — the
 * direction a page is already read, so the composition carries the eye across
 * rather than pinning it to one corner or spreading evenly and saying nothing.
 * A centred version was tried and read as a spotlight behind the headline; the
 * diagonal leaves the middle of the page calm, which is where the words are.
 *
 * **Layer order is load-bearing, and it is the reason this file has a bug
 * history.** The floor (below) is a near-opaque scrim over the bottom of the
 * viewport, and the lower-right light is centred at 0.75 of viewport height —
 * inside it. Painted in source order with the floor last, the floor covered
 * that light at ~89% ink and the page showed exactly one glow. Nothing was
 * broken, nothing warned, and the CSS read correctly line by line. So the
 * second light is painted *after* the floor, and anything added here has to
 * say which side of the floor it belongs on.
 *
 * **The motion is real, and it is slow.** An earlier version animated scale and
 * opacity only, on the theory that a light which travels reads as restless.
 * That was half right and produced something worse: at 6% scale over 31s the
 * sky was, for practical purposes, a still image, and the only time it seemed
 * to move was when the page scrolled past it. A real aurora drifts and changes
 * shape. So each light now runs four slow tracks — translate, rotate, scale,
 * opacity — on four different periods, none a multiple of another, so the
 * combination does not come back around inside any session anyone will sit
 * through. The restlessness of the first attempt came from short periods and
 * large travel, not from travel as such.
 *
 * Those are the independent transform properties, not a `transform` shorthand,
 * and that is deliberate on two counts. They compose without the tracks having
 * to know about each other — a shorthand would make one animation win and
 * silently drop the other three — and each is composited on its own. The one
 * trap: Tailwind's centring utilities also write the `translate` property, and
 * it COMPOSES rather than overriding, so animating `translate` on a layer
 * centred that way applies both and puts it half its own width off (measured
 * at 535px, and on screen it read only as "the left side is a bit brighter").
 * These layers are anchored by negative insets and carry no translate utility,
 * which is what makes this safe.
 *
 * `fixed`, not `absolute`. A sky that scrolls away after the first screen is a
 * decoration on the header; one that stays is weather the page is standing in.
 * It is also one layer for the whole document rather than one per section, so
 * the cost does not grow as the page does.
 *
 * Layered gradients rather than an image or a canvas: soft stops give the
 * diffusion for free where `filter: blur()` over a full-viewport layer costs a
 * repaint every frame, nothing is downloaded on a page that already lazy-loads
 * three.js, and the four animated properties are all compositor-only, so the
 * main thread — which on the landing page is running a force simulation — is
 * never asked to lay anything out.
 *
 * Server component: no state, no effects, nothing added to the client bundle.
 */
export function Aurora({
  intensity = "full",
}: {
  /**
   * `full` for the marketing surfaces, where atmosphere is the point.
   *
   * `quiet` for the signed-in ones. The map draws districts in six low-chroma
   * hues and reads certainty off colour; a violet wash at full strength behind
   * it would shift every one of them. Where colour carries meaning, the sky
   * gets out of the way.
   */
  intensity?: "full" | "quiet";
}) {
  const full = intensity === "full";

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      {/* The ground the light sits in. Without it the glows read as coloured
          blobs on black; with it they read as one sky. Kept close to the ink —
          a saturated violet here tints every surface on the page at once, and
          it is the one layer with no falloff to soften it. */}
      <div
        className="absolute inset-0"
        style={{
          background: full
            ? "linear-gradient(180deg, #171029 0%, #130c20 32%, #100b18 60%, #0d0c0a 100%)"
            : "linear-gradient(180deg, #130d20 0%, #0f0a18 46%, #0d0c0a 100%)",
        }}
      />

      {/*
        Upper left, and the brighter of the two. It carries the near-white core
        the reference photograph is built around — one place only, because two
        bright cores read as decoration rather than as a sky.

        Low alphas on purpose. Aurora in a photograph is thin: you see the sky
        through it. Past roughly 0.3 the gradient stops being light and starts
        being a violet surface, which is what "too deep" meant.

        Strength lives on this wrapper and motion on the child. One element
        cannot do both: a keyframe that touches `opacity` replaces the class for
        the whole animation rather than blending with it — an earlier version
        wrote `opacity: inherit` into a keyframe expecting a no-op and got a
        layer that ignored its own intensity. Two elements multiply, so the
        shimmer stays a percentage of whatever the surface asked for.
      */}
      <div className={`absolute inset-0 ${full ? "opacity-85" : "opacity-32"}`}>
        <div
          className="aurora-crown absolute -top-[40%] -left-[26%] h-[118%] w-[104%]"
          style={{
            background:
              "radial-gradient(closest-side at 50% 50%, rgba(219,197,255,0.25) 0%, rgba(167,113,247,0.26) 26%, rgba(116,62,200,0.16) 48%, rgba(72,36,132,0.07) 70%, transparent 86%)",
          }}
        />
      </div>

      {/*
        The floor. Everything above is a light source, and without this the
        whole document would sit on violet — text was designed against the ink,
        and a wash over all of it quietly takes contrast away. This settles the
        lower half back down so long-form reading keeps the ground it was
        measured on.

        It comes before the second light, not after. See the note at the top.
      */}
      <div
        className={`absolute inset-x-0 bottom-0 ${full ? "h-[56%]" : "h-[70%]"}`}
        style={{
          background:
            "linear-gradient(to top, var(--color-ink) 0%, color-mix(in oklab, var(--color-ink) 86%, transparent) 46%, transparent 100%)",
        }}
      />

      {/*
        Lower right: the answer to it, and the half of the composition that was
        missing. Colder and dimmer than the crown, so it balances the diagonal
        without competing for attention — the reference has its curtain
        overhead and its light again on the horizon, and this is that second
        light.

        Dimmer than the crown by design *and* by position: this one sits over
        the reading half of the page, so it is the layer that would cost
        contrast if it got generous. Its tracks run slower than the crown's
        too — the far light in a sky is the one that appears to move least.
      */}
      <div className={`absolute inset-0 ${full ? "opacity-75" : "opacity-24"}`}>
        <div
          className="aurora-deep absolute -right-[22%] -bottom-[30%] h-[110%] w-[96%]"
          style={{
            background:
              "radial-gradient(closest-side at 50% 50%, rgba(181,151,252,0.20) 0%, rgba(126,86,228,0.16) 30%, rgba(78,48,162,0.07) 58%, transparent 80%)",
          }}
        />
      </div>
    </div>
  );
}
