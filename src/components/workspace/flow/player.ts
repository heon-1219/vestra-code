/**
 * The transport — play, pause, 1x/2x, replay, step — as arithmetic.
 *
 * This is the part the founder asked for by name: "1x 2x 이런식으로 play speed
 * 조정 가능하게, replay 가능하게". It is a pure module so the rules can be
 * tested without a browser, a clock or a canvas; the hook beside it owns the
 * timer and the React state, and this owns what the numbers are allowed to be.
 *
 * ## The one rule that makes this honest
 *
 * **The whole path is computed before the first step is drawn.** The walk is
 * microseconds (`FLOW_TRACKING.md` §5), so nothing here is waiting for
 * anything: this is an animation of a finished answer, the way a slider through
 * a document is. Which is why nothing in this feature ever says 실시간, shows a
 * spinner, or draws anything that could be read as progress — a bar filling up
 * beside a path that was already complete would be the product inventing work
 * it did not do. The scrubber is a scrubber, and it is labelled as position.
 *
 * `revealed` is therefore a **position in a finished list**, never a count of
 * work done, and every function here can move it both ways.
 *
 * ## prefers-reduced-motion turns the pacing off entirely
 *
 * Not "makes it faster": a flow opened by someone who asked for less motion
 * shows every step at once and does not play. The controls stay, because
 * stepping through a path by hand is not motion and is the more careful way to
 * read one anyway. `district-map.tsx` already follows this rule for its camera
 * and this is the same rule, one screen over.
 */

/**
 * The speeds on the control.
 *
 * Two, which is what the founder named, and **not more**. A third and fourth
 * were drawn and dropped: this panel is `minmax(272px, 25%)` and at its
 * narrowest holds about 240px, which the five transport buttons and a scrubber
 * already fill — and every one of them is 44px on a phone. A speed control that
 * has to be scrolled to is worse than one with two settings.
 */
export const FLOW_SPEEDS = [1, 2] as const;

export type FlowSpeed = (typeof FLOW_SPEEDS)[number];

/**
 * How long one step is held at 1x, in milliseconds.
 *
 * Read rather than chosen: a hop's row is one short Korean sentence — "화면
 * 조각이에요, 2곳에서 써요" plus its verb — and reading one is about a second.
 * 1,200ms leaves a beat after it. Twelve hops, which is `MAX_FLOW_HOPS`, is
 * then about fourteen seconds at 1x and seven at 2x, which is the length of the
 * thing rather than a wait for it.
 *
 * §12.5 of the spec says plainly that nobody has watched a person sit through
 * this yet. It is one constant in one pure file for that reason.
 */
export const STEP_MS = 1200;

export type Player = {
  /**
   * How many hops are showing. Zero is the start standing alone, which is a
   * real state: it is what a flow looks like before its first step.
   */
  revealed: number;
  playing: boolean;
  speed: FlowSpeed;
};

/** How long the current step is held, at the current speed. */
export function stepMs(speed: FlowSpeed): number {
  return Math.round(STEP_MS / speed);
}

function clamp(value: number, hops: number): number {
  return Math.min(Math.max(value, 0), hops);
}

/**
 * A player for a path that has just been computed.
 *
 * Starts at 1 rather than 0 when it is going to play, so the first step is on
 * screen in the first frame: a flow that opens on an empty list and fills its
 * first row a second later reads as the product still working something out,
 * which is the one impression this feature may not give.
 */
export function openPlayer(hops: number, reduced: boolean): Player {
  if (reduced) return { revealed: hops, playing: false, speed: 1 };
  return { revealed: Math.min(1, hops), playing: hops > 1, speed: 1 };
}

/** Whether every step is on screen. */
export function atEnd(player: Player, hops: number): boolean {
  return player.revealed >= hops;
}

/**
 * One tick of the timer: the next step appears.
 *
 * Stops playing when it arrives at the last one, rather than looping. A path
 * that restarted on its own would take the reader back to the beginning of a
 * story they had just finished, and there is a 처음부터 button for people who
 * want that.
 */
export function tick(player: Player, hops: number): Player {
  if (!player.playing) return player;
  const next = clamp(player.revealed + 1, hops);
  return { ...player, revealed: next, playing: next < hops };
}

/**
 * Play, or pause.
 *
 * Pressing play at the end starts again from the top, which is what every
 * player anyone has ever used does, and is why a separate 처음부터 button is not
 * the only way back.
 */
export function togglePlay(player: Player, hops: number): Player {
  if (player.playing) return { ...player, playing: false };
  if (atEnd(player, hops)) return replay(player, hops);
  return { ...player, playing: hops > player.revealed };
}

/**
 * Forward or back by one, by hand.
 *
 * Always pauses. Someone who has reached for the step button has taken over,
 * and a path that carried on moving underneath them would take the step they
 * just asked for back off the screen.
 */
export function step(player: Player, hops: number, delta: number): Player {
  return { ...player, revealed: clamp(player.revealed + delta, hops), playing: false };
}

/** The scrubber. Pauses, for the reason `step` does. */
export function seek(player: Player, hops: number, to: number): Player {
  return { ...player, revealed: clamp(to, hops), playing: false };
}

/** From the top, playing. The founder's replay. */
export function replay(player: Player, hops: number): Player {
  return { ...player, revealed: Math.min(1, hops), playing: hops > 1 };
}

/**
 * Change speed without changing place or whether it is playing.
 *
 * Both of those are things the person set on purpose, and a speed button that
 * also restarted the path would make 2x a way of losing your place.
 */
export function setSpeed(player: Player, speed: FlowSpeed): Player {
  return { ...player, speed };
}

/**
 * Everything on screen at once, not playing.
 *
 * What `prefers-reduced-motion` opens on, and also what the 전체 보기 button
 * does for anyone who would rather read a path than watch one.
 */
export function showAll(player: Player, hops: number): Player {
  return { ...player, revealed: hops, playing: false };
}
