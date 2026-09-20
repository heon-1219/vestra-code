import { describe, expect, it } from "vitest";

import {
  atEnd,
  FLOW_SPEEDS,
  openPlayer,
  replay,
  seek,
  setSpeed,
  showAll,
  step,
  stepMs,
  STEP_MS,
  tick,
  togglePlay,
  type Player,
} from "./player";

/**
 * The transport the founder asked for by name.
 *
 * "1x 2x 이런식으로 play speed 조정 가능하게, replay 가능하게" — so: it plays, it
 * pauses, it has two speeds, it starts again from the top, and it moves a step
 * at a time in both directions. All of that is arithmetic and all of it is
 * tested here without a browser or a clock.
 *
 * The one rule with teeth is the last block: **`prefers-reduced-motion` turns
 * the pacing off**, and off means the whole path is on screen at once, not a
 * faster animation of it.
 */

const HOPS = 4;

/** Run the timer to a standstill, so a test cannot hang on a bad stop rule. */
function runOut(player: Player, hops: number, limit = 50): { player: Player; ticks: number } {
  let current = player;
  let ticks = 0;
  while (current.playing && ticks < limit) {
    current = tick(current, hops);
    ticks += 1;
  }
  return { player: current, ticks };
}

describe("opening a flow", () => {
  it("shows the first step straight away rather than an empty list", () => {
    // A list that fills its first row a second later reads as the product
    // still working something out, which is the one impression this feature
    // may not give: the path was finished before the first step was drawn.
    const player = openPlayer(HOPS, false);
    expect(player.revealed).toBe(1);
    expect(player.playing).toBe(true);
  });

  it("starts at 1x", () => {
    expect(openPlayer(HOPS, false).speed).toBe(1);
  });

  it("does not play a one-step path", () => {
    const player = openPlayer(1, false);
    expect(player.revealed).toBe(1);
    expect(player.playing).toBe(false);
  });

  it("survives a path with no steps at all", () => {
    const player = openPlayer(0, false);
    expect(player.revealed).toBe(0);
    expect(player.playing).toBe(false);
  });
});

describe("playing", () => {
  it("reveals one step per tick and stops at the last one", () => {
    const { player, ticks } = runOut(openPlayer(HOPS, false), HOPS);
    expect(player.revealed).toBe(HOPS);
    expect(player.playing).toBe(false);
    expect(ticks).toBe(HOPS - 1);
  });

  it("never loops back to the beginning on its own", () => {
    // A path that restarted by itself would take the reader back to the start
    // of a story they had just finished.
    const { player } = runOut(openPlayer(HOPS, false), HOPS);
    expect(atEnd(player, HOPS)).toBe(true);
    expect(tick(player, HOPS)).toEqual(player);
  });

  it("ignores a tick while paused", () => {
    const paused = togglePlay(openPlayer(HOPS, false), HOPS);
    expect(paused.playing).toBe(false);
    expect(tick(paused, HOPS)).toEqual(paused);
  });
});

describe("play and pause on one button", () => {
  it("pauses what is playing", () => {
    expect(togglePlay(openPlayer(HOPS, false), HOPS).playing).toBe(false);
  });

  it("carries on from where it was paused", () => {
    // `step` already pauses, which is the point of it.
    const paused = step(openPlayer(HOPS, false), HOPS, 1);
    expect(paused.playing).toBe(false);
    const going = togglePlay(paused, HOPS);
    expect(going.playing).toBe(true);
    expect(going.revealed).toBe(paused.revealed);
  });

  it("starts again from the top when it is already at the end", () => {
    const { player } = runOut(openPlayer(HOPS, false), HOPS);
    const again = togglePlay(player, HOPS);
    expect(again.revealed).toBe(1);
    expect(again.playing).toBe(true);
  });
});

describe("stepping by hand", () => {
  it("moves one step and takes over", () => {
    // Someone who reached for the step button has taken over, and a path that
    // carried on moving underneath them would take the step they just asked
    // for back off the screen.
    const forward = step(openPlayer(HOPS, false), HOPS, 1);
    expect(forward.revealed).toBe(2);
    expect(forward.playing).toBe(false);
  });

  it("goes backwards, which is the half a paced reveal cannot do", () => {
    const back = step(step(openPlayer(HOPS, false), HOPS, 2), HOPS, -1);
    expect(back.revealed).toBe(2);
  });

  it("stops at both ends rather than going past them", () => {
    expect(step(openPlayer(HOPS, false), HOPS, -9).revealed).toBe(0);
    expect(step(openPlayer(HOPS, false), HOPS, 99).revealed).toBe(HOPS);
  });
});

describe("the scrubber", () => {
  it("goes anywhere in the path, both ways, and pauses", () => {
    const at = seek(openPlayer(HOPS, false), HOPS, 3);
    expect(at.revealed).toBe(3);
    expect(at.playing).toBe(false);
    expect(seek(at, HOPS, 1).revealed).toBe(1);
  });

  it("clamps rather than accepting a number from outside the path", () => {
    expect(seek(openPlayer(HOPS, false), HOPS, 900).revealed).toBe(HOPS);
    expect(seek(openPlayer(HOPS, false), HOPS, -900).revealed).toBe(0);
  });
});

describe("replay", () => {
  it("goes back to the top and plays", () => {
    const { player } = runOut(openPlayer(HOPS, false), HOPS);
    const again = replay(player, HOPS);
    expect(again.revealed).toBe(1);
    expect(again.playing).toBe(true);
  });

  it("keeps the speed the person chose", () => {
    const fast = setSpeed(openPlayer(HOPS, false), 2);
    expect(replay(fast, HOPS).speed).toBe(2);
  });
});

describe("speed", () => {
  it("offers 1x and 2x, and 2x is half the wait", () => {
    expect([...FLOW_SPEEDS]).toEqual([1, 2]);
    expect(stepMs(1)).toBe(STEP_MS);
    expect(stepMs(2)).toBe(STEP_MS / 2);
  });

  it("changes nothing but the speed", () => {
    // A speed button that also restarted the path would make 2x a way of
    // losing your place.
    const half = tick(openPlayer(HOPS, false), HOPS);
    const fast = setSpeed(half, 2);
    expect(fast.revealed).toBe(half.revealed);
    expect(fast.playing).toBe(half.playing);
  });
});

describe("prefers-reduced-motion", () => {
  it("shows the whole path at once and does not play", () => {
    // Off, not faster. The controls stay, because stepping through a path by
    // hand is not motion.
    const player = openPlayer(HOPS, true);
    expect(player.revealed).toBe(HOPS);
    expect(player.playing).toBe(false);
    expect(atEnd(player, HOPS)).toBe(true);
  });

  it("leaves every control still working", () => {
    const player = openPlayer(HOPS, true);
    expect(step(player, HOPS, -1).revealed).toBe(HOPS - 1);
    expect(seek(player, HOPS, 2).revealed).toBe(2);
    expect(setSpeed(player, 2).speed).toBe(2);
  });
});

describe("한 번에 다 보기", () => {
  it("jumps to the end without playing", () => {
    const all = showAll(openPlayer(HOPS, false), HOPS);
    expect(all.revealed).toBe(HOPS);
    expect(all.playing).toBe(false);
  });
});
