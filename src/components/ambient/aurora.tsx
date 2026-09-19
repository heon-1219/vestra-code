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
 * **It holds still and it is balanced.** An earlier version swept from one
 * corner and each layer drifted on its own period, which read as restless —
 * the eye kept following the bright part to wherever it had wandered. Now the
 * crown is centred on the horizontal midline and everything only *breathes*:
 * the animations scale and fade, and none of them translates, because
 * translating is exactly what moves a centre off centre.
 *
 * One glow sits low and to the right against it. A page is read top-left to
 * bottom-right, and a composition weighted entirely along the top edge leaves
 * the eye finishing on nothing — the same diagonal answer the reference
 * photograph gives, with its curtain overhead and its light again on the
 * horizon.
 *
 * `fixed`, not `absolute`. A sky that scrolls away after the first screen is a
 * decoration on the header; one that stays is weather the page is standing in.
 * It is also one layer for the whole document rather than one per section, so
 * the cost does not grow as the page does.
 *
 * Layered gradients rather than an image or a canvas: soft stops give the
 * diffusion for free where `filter: blur()` over a full-viewport layer costs a
 * repaint every frame, nothing is downloaded on a page that already lazy-loads
 * three.js, and `transform`/`opacity` are compositor-only, so the main thread —
 * which on the landing page is running a force simulation — is never asked to
 * lay anything out.
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
          blobs on black; with it they read as one sky. */}
      <div
        className="absolute inset-0"
        style={{
          background: full
            ? "linear-gradient(180deg, #1d1038 0%, #170d2c 30%, #110a1f 58%, #0d0c0a 100%)"
            : "linear-gradient(180deg, #160e28 0%, #110a1e 46%, #0d0c0a 100%)",
        }}
      />

      {/*
        The crown. Centred on the horizontal midline and anchored above the
        fold, which is where an aurora actually sits when you are standing under
        one — overhead and ahead, not off to one side.
      */}
      <div
        className={`aurora-breathe absolute left-1/2 -translate-x-1/2 -top-[45%] h-[130%] w-[150%] ${
          full ? "opacity-95" : "opacity-40"
        }`}
        style={{
          background:
            "radial-gradient(closest-side at 50% 50%, rgba(214,186,255,0.42) 0%, rgba(162,98,248,0.46) 26%, rgba(116,56,204,0.32) 48%, rgba(72,32,136,0.14) 68%, transparent 84%)",
        }}
      />

      {/* A wider, slower halo on the same centre, so the edge of the crown does
          not end in a visible ring. */}
      <div
        className={`aurora-halo absolute left-1/2 -translate-x-1/2 -top-[70%] h-[175%] w-[210%] ${
          full ? "opacity-70" : "opacity-25"
        }`}
        style={{
          background:
            "radial-gradient(closest-side at 50% 50%, rgba(138,86,232,0.30) 0%, rgba(92,54,178,0.18) 40%, rgba(60,36,124,0.08) 66%, transparent 82%)",
        }}
      />

      {/*
        The counterweight, low and to the right.
        
        The crown alone puts every bright thing along one edge, and a page is
        read top-left to bottom-right — so the eye finishes on nothing. This
        answers it diagonally, the way the reference photograph has its glow
        overhead and its light again on the horizon. Colder and much dimmer than
        the crown, so it balances the composition without competing for it.
      */}
      <div
        className={`aurora-deep absolute -right-[18%] -bottom-[28%] h-[105%] w-[95%] ${
          full ? "opacity-70" : "opacity-24"
        }`}
        style={{
          background:
            "radial-gradient(closest-side at 50% 50%, rgba(128,92,238,0.30) 0%, rgba(80,54,180,0.18) 40%, rgba(56,34,118,0.07) 66%, transparent 82%)",
        }}
      />

      {/*
        The floor. Everything above is a light source, and without this the
        whole document would sit on violet — text was designed against the ink,
        and a wash over all of it quietly takes contrast away. This settles the
        lower half back down so long-form reading keeps the ground it was
        measured on.
      */}
      <div
        className={`absolute inset-x-0 bottom-0 ${full ? "h-[58%]" : "h-[72%]"}`}
        style={{
          background:
            "linear-gradient(to top, var(--color-ink) 0%, color-mix(in oklab, var(--color-ink) 88%, transparent) 46%, transparent 100%)",
        }}
      />
    </div>
  );
}
