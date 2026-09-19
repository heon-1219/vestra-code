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
 * **Two lights on a diagonal, and they hold still.** One upper left, one lower
 * right — the direction a page is already read, so the composition carries the
 * eye across rather than pinning it to one corner or spreading evenly and
 * saying nothing. A centred version was tried and read as a spotlight behind
 * the headline; the diagonal leaves the middle of the page calm, which is
 * where the words are.
 *
 * Both glows are anchored to their corners and never move. The animations
 * scale and fade and nothing translates, because translating is what turns a
 * fixed light into a wandering one — an earlier version drifted on three
 * separate periods and read as restless, with the eye following the bright
 * part to wherever it had gone.
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
        Upper left, and the brighter of the two. It carries the near-white core
        the reference photograph is built around — one place only, because two
        bright cores read as decoration rather than as a sky.
      */}
      <div
        className={`aurora-crown absolute -top-[42%] -left-[26%] h-[120%] w-[105%] ${
          full ? "opacity-95" : "opacity-38"
        }`}
        style={{
          background:
            "radial-gradient(closest-side at 50% 50%, rgba(214,186,255,0.44) 0%, rgba(162,98,248,0.46) 24%, rgba(116,56,204,0.30) 46%, rgba(72,32,136,0.13) 68%, transparent 84%)",
        }}
      />

      {/*
        Lower right: the answer to it. Colder and dimmer, so it balances the
        diagonal without competing for attention — the reference has its
        curtain overhead and its light again on the horizon, and this is that
        second light.
      */}
      <div
        className={`aurora-deep absolute -right-[24%] -bottom-[34%] h-[115%] w-[100%] ${
          full ? "opacity-80" : "opacity-26"
        }`}
        style={{
          background:
            "radial-gradient(closest-side at 50% 50%, rgba(140,102,244,0.34) 0%, rgba(86,58,190,0.20) 38%, rgba(56,34,118,0.08) 64%, transparent 82%)",
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
