/**
 * Where a run's wall clock goes, one phase at a time.
 *
 * A lap timer and nothing else. It exists because "the analysis got slower"
 * was a sentence this codebase could say and not answer: the run row records
 * a start and a finish, and the five minutes between them were one number.
 * Deciding what to make faster needs that number broken down, and a guess
 * about which phase dominates is exactly the kind of claim this repository
 * does not act on without measuring.
 *
 * Logged, never persisted and never shown. It is for the person deciding what
 * to optimise, not for the person reading the map.
 */

export type PhaseClock = {
  /** Close the phase that was running and name it. */
  lap: (phase: string) => void;
  /** Milliseconds per phase in the order they ran, plus `total`. */
  report: () => Record<string, number>;
};

export function phaseClock(now: () => number = () => performance.now()): PhaseClock {
  const started = now();
  let last = started;
  const laps: [string, number][] = [];

  return {
    lap(phase) {
      const at = now();
      // A phase that runs twice (a retried step, a re-entered branch) adds up
      // rather than overwriting, so the parts still sum to the whole.
      const existing = laps.find(([name]) => name === phase);
      if (existing) existing[1] += at - last;
      else laps.push([phase, at - last]);
      last = at;
    },
    report() {
      const out: Record<string, number> = {};
      for (const [name, ms] of laps) out[name] = Math.round(ms);
      out.total = Math.round(now() - started);
      return out;
    },
  };
}
