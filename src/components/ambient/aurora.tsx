/**
 * Aurora: light in a dark room, not a second accent colour.
 *
 * The product was one flat black and read as austere rather than calm. This
 * puts atmosphere behind the whole site — but atmosphere only. The palette has
 * exactly one accent, the lamp amber, and it means "you act here"; if violet
 * started carrying meaning too, every button would have to compete with the
 * sky. So the aurora never touches an interactive element, never appears above
 * content, and stays far below the contrast at which it could be mistaken for
 * something to act on.
 *
 * `fixed`, not `absolute`. A sky that scrolls away after the first screen is a
 * decoration on the header; one that stays is weather the page happens to be
 * standing in. It also means one layer for the entire document rather than one
 * per section, so the cost does not grow as the page does.
 *
 * Built from layered gradients rather than an image or a canvas. A gradient's
 * soft stops give the diffusion for free where a `filter: blur()` over a
 * full-viewport layer costs a repaint every frame; nothing is downloaded, which
 * matters on a page that already lazy-loads three.js; and only `transform`
 * animates, which the compositor owns without waking the main thread — the same
 * main thread that is running a force simulation on the landing page.
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
      {/* The ground the light sits in. Without this the gradients read as three
          coloured blobs on black; with it they read as one sky. */}
      <div
        className="absolute inset-0"
        style={{
          background: full
            ? "linear-gradient(170deg, #1b0f33 0%, #150c28 34%, #0f0a1c 62%, #0d0c0a 100%)"
            : "linear-gradient(170deg, #150d26 0%, #110a1d 48%, #0d0c0a 100%)",
        }}
      />

      {/* The main ribbon: a long diagonal sweep with a bright core, which is the
          shape the reference photograph is built around. */}
      <div
        className={`aurora-drift absolute -top-[25%] -left-[15%] h-[125%] w-[95%] ${
          full ? "opacity-90" : "opacity-40"
        }`}
        style={{
          background:
            "radial-gradient(58% 46% at 40% 34%, rgba(158,94,246,0.62) 0%, rgba(118,58,206,0.44) 34%, rgba(74,34,140,0.22) 58%, transparent 76%)",
        }}
      />

      {/* The bright fall — where the ribbon brightens to near-white before it
          fades out. One place only: two of these and it reads as decoration. */}
      <div
        className={`aurora-fall absolute -top-[15%] right-[2%] h-[105%] w-[50%] ${
          full ? "opacity-85" : "opacity-35"
        }`}
        style={{
          background:
            "radial-gradient(40% 60% at 62% 26%, rgba(222,196,255,0.52) 0%, rgba(168,108,242,0.38) 30%, rgba(104,52,186,0.18) 56%, transparent 74%)",
        }}
      />

      {/* A colder counterweight, low and left, so the warmth in the ink still
          has something to be warm against. */}
      <div
        className={`aurora-slow absolute -bottom-[30%] left-[12%] h-[80%] w-[70%] ${
          full ? "opacity-75" : "opacity-30"
        }`}
        style={{
          background:
            "radial-gradient(55% 52% at 50% 58%, rgba(88,86,236,0.40) 0%, rgba(68,48,166,0.22) 44%, transparent 72%)",
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
        className={`absolute inset-x-0 bottom-0 ${full ? "h-[55%]" : "h-[70%]"}`}
        style={{
          background:
            "linear-gradient(to top, var(--color-ink) 0%, color-mix(in oklab, var(--color-ink) 88%, transparent) 45%, transparent 100%)",
        }}
      />
    </div>
  );
}
