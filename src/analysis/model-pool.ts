// `@/lib/llm/types` and never the package index: the index reaches `env.ts`,
// which validates 21 variables at import time and throws. `LlmError` is a
// class, so this is a runtime import, and it has to stay importable from a
// test with no key.
import { LlmError, type Llm, type LlmReply, type LlmRequest } from "@/lib/llm/types";

/**
 * Model calls, several at a time, with answers that come back in order.
 *
 * Every model pass in this pipeline used to ask one question, wait for the
 * answer, and only then ask the next. Measured on a full re-read of
 * `vestra-code` (D159): **284 of the run's 348 seconds were spent waiting for
 * 74 answers one after another**, at 3.6 to 4.2 seconds each. The provider was
 * never the limit — sixteen questions sent at once came back with sixteen
 * answers and no refusals — the loop was.
 *
 * Two pieces, and they are separate because they solve separate problems:
 *
 *   - `runInOrder` runs a pass's batches a few at a time and hands the results
 *     back **in the order the batches were built**, never the order they
 *     finished. A pass then folds them in that order, so the rows it writes
 *     are the rows the one-at-a-time loop would have written for the same
 *     answers. Concurrency changes when an answer arrives, never which answer
 *     lands where.
 *   - `patientLlm` makes a refusal something the run waits out rather than
 *     something that costs a batch. A 429 used to mark twelve files as never
 *     opened; now every caller pauses together, and the batch is asked again.
 */

/**
 * How many questions one pass keeps in flight.
 *
 * Measured, not chosen (D159). Sixteen tiny requests sent at once to the
 * configured endpoint all succeeded but took 6.8 s, against 1.6 s for eight:
 * past eight the provider queues rather than refuses. Then six against eight
 * on full re-reads, with **zero refusals at either width**:
 *
 *   - `Kim-and-Chang-` at six: 31.8, 31.9, 32.4 s. At eight: 31.7, 38.9, 48.2 s.
 *   - `vestra-code` at six: 92.8, 99.9 s. At eight: 89.5 s.
 *
 * Eight was never reliably faster and was far less steady: its slow runs were
 * single answers taking twice as long while the others waited on them, which
 * is what a provider near its knee does. Six is the widest setting that came
 * out the same every time.
 */
export const MODEL_CONCURRENCY = 6;

/** One item's outcome. `ran: false` means it was never started. */
export type Slot<R> = { ran: true; value: R } | { ran: false };

/**
 * Run `work` over `items`, at most `limit` at a time, launching in order.
 *
 * `keepGoing(index)` is asked immediately before item `index` is launched, and
 * the first "no" stops every later launch. It is a way to stop spending, not a
 * way to decide the result: which items get launched depends on which earlier
 * ones have finished, so a caller that wants the same rows twice must decide
 * what to keep by walking the slots in order — the rule every pass here
 * follows, and the reason this returns slots rather than a filtered list.
 *
 * `work` is expected not to throw; every pass wraps its own call and returns
 * an outcome. If one does, the error is re-thrown once everything already in
 * flight has settled, so no call is left running unobserved.
 */
export async function runInOrder<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
  keepGoing: (index: number) => boolean = () => true,
  /** Send the first item on its own before widening. See below. */
  leadAlone = true,
): Promise<Slot<R>[]> {
  const slots: Slot<R>[] = items.map(() => ({ ran: false }));
  let next = 0;
  let stopped = false;
  let failure: { error: unknown } | null = null;

  const launch = async (): Promise<boolean> => {
    if (stopped || failure !== null || next >= items.length) return false;
    const index = next;
    if (!keepGoing(index)) {
      stopped = true;
      return false;
    }
    next += 1;
    try {
      slots[index] = { ran: true, value: await work(items[index], index) };
    } catch (error) {
      failure ??= { error };
    }
    return true;
  };

  /*
   * The first question goes alone.
   *
   * A wrong key is wrong on every batch, and six batches sent at once would
   * spend six requests discovering what the first one already knew — the
   * one-at-a-time loop this replaces cost exactly one, and a test pins that.
   * One batch's latency is the whole price, and it buys the same answer about
   * a rate limit: a pass that is refused on its first call waits before it
   * widens rather than after.
   *
   * A caller that already knows the key works — an earlier pass of the same
   * run was answered — says so with `leadAlone: false` and skips the price.
   */
  if (leadAlone) await launch();

  const worker = async () => {
    while (await launch()) {
      // `launch` does the work; the loop only keeps this worker busy.
    }
  };
  const width = Math.max(1, Math.min(limit, items.length - (leadAlone ? 1 : 0)));
  await Promise.all(Array.from({ length: width }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return slots;
}

export type Patience = {
  /** Further attempts after the first refusal. */
  retries: number;
  /**
   * Further attempts after the client's own timeout — the endpoint accepting
   * the question and then saying nothing for two minutes. Counted apart from
   * `retries` because one of these costs a hundred and twenty seconds, not
   * one. See `patientLlm`.
   */
  timeoutRetries: number;
  /** The first wait. Each later one doubles, up to `maxDelayMs`. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injectable so a test does not wait in real time. */
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Told about every refusal that is going to be waited out. For the log. */
  onRefused?: (kind: LlmError["kind"], attempt: number, waitMs: number) => void;
};

/*
 * Five more tries over a little more than a minute: 2, 4, 8, 16, 32 seconds,
 * 62 in all.
 *
 * A minute because that is the window a provider's per-minute quota resets
 * in, and the first schedule stopped short of it. It was four tries over
 * thirty seconds, and a simulation through this wrapper and `runInOrder` — 60
 * batches, six wide, one-second answers, a refusal window opening five seconds
 * in (`model-pool.test.ts`) — lost **0 of 60 batches to a 25 s window, 6 to a
 * 35 s one and 41 to a 45 s or 60 s one**: the first caller ran out of retries
 * inside the window, the breaker below then turned every later refusal into
 * an instant loss, and the rest of the pass was thrown away seconds before the
 * provider would have answered it. With 62 s, **all four windows lose 0**.
 * What it costs is the spending-cap case: a refusal that never ends is given
 * up on after about a minute rather than half of one — the same simulation
 * ends a permanently refused pass at 78 s instead of 45 s, 65 attempts
 * instead of 64 — once per run, because the breaker is shared by every pass.
 *
 * A timeout gets one more try, not five: see `patientLlm` (D178).
 */
const DEFAULT_PATIENCE: Patience = {
  retries: 5,
  timeoutRetries: 1,
  baseDelayMs: 2_000,
  maxDelayMs: 32_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * A model that remembers whether it has ever been answered.
 *
 * The pipeline hands one of these to every pass, so a later pass can skip the
 * first-question-alone probe once an earlier one has proved the key works
 * (`runInOrder`'s `leadAlone`). Measured on `Kim-and-Chang-` (D159), the probe
 * is one full call's wait per pass — 3 to 4 seconds each, on a run that now
 * takes about forty.
 */
export function provenLlm(llm: Llm): Llm & { readonly proven: boolean } {
  let proven = false;
  return {
    get proven() {
      return proven;
    },
    async complete(request) {
      const reply = await llm.complete(request);
      proven = true;
      return reply;
    },
  };
}

/**
 * A model that waits out refusals instead of passing them up.
 *
 * **One pause for everyone.** When any call is told to slow down, every call
 * made through this wrapper waits until the same moment before it tries
 * again or starts — six workers each retrying on their own would keep the
 * provider exactly as busy as the thing it just refused.
 *
 * What counts as worth waiting for is `LlmError.retryable` — a 429, a 5xx, a
 * connection that did not open — plus one case the client cannot tell apart
 * from a cancellation: **the client's own two-minute timeout** surfaces as
 * `aborted`, the same kind as a caller giving up. When the caller's signal is
 * not the one that fired, it was the endpoint going quiet, which is transient,
 * and treating it as a cancellation used to end the whole pass on one slow
 * answer.
 *
 * Everything else — a wrong key, a request the endpoint will not accept — is
 * passed up at once. Retrying it only spends the person's time before telling
 * them the same thing.
 *
 * When the retries run out the last error is passed up unchanged, so each
 * pass counts the batch the way it always has: as files not opened, with the
 * reason a person reads.
 *
 * **And once one call has run out, nobody waits again.** Measured, the hard way
 * (D159): partway through this work the provider began answering every request
 * with a 429 that meant "this month's spending cap is reached" — the same
 * status as "slow down", and the client cannot tell them apart. Every batch
 * then waited its full half-minute before giving up, and a re-read of
 * `Kim-and-Chang-` that takes 32 s took **330 s** to produce the same empty
 * answer. A provider that has refused one question six times over a minute
 * is not having a busy moment, so from then on a refusal is passed up
 * at once: the run finishes in its usual time, says which files the model
 * never opened, and the next run tries again from the start.
 *
 * **A timeout is retried once, and an endpoint that goes quiet twice is not
 * asked again this run (D178).** A refusal comes back in a second; a timeout
 * is the client giving up after two minutes of silence. Retried on the
 * refusal schedule, one hung call cost six timeouts and the waits between
 * them — 782 s — and the Python model half writes no progress while it
 * waits, so a watched run went quiet for longer than the ten minutes after
 * which `run-store.ts` declares a run dead, and was marked failed while
 * still working. A virtual-clock simulation of a hung endpoint
 * (`model-pool.test.ts`) put a 17-file Python half at **1,142 s** and a
 * 40-batch Pass 3 at **1,622 s** on that schedule. Now one slow answer is
 * still asked again, so a single hiccup costs nothing; a second silence in
 * the same call means the endpoint is not answering, and every later call
 * fails at once without being sent — the same simulation ends both passes at
 * **242 s**. Calls already in flight finish or time out on their own, and a
 * call that is answered clears it, the way an answer clears the refusal
 * breaker above.
 */
export function patientLlm(llm: Llm, options: Partial<Patience> = {}): Llm {
  const patience = { ...DEFAULT_PATIENCE, ...options };
  let resumeAt = 0;
  let exhausted = false;
  let quiet = false;

  return {
    async complete(request: LlmRequest): Promise<LlmReply> {
      let refusals = 0;
      let timeouts = 0;
      for (let attempt = 0; ; attempt += 1) {
        const wait = resumeAt - patience.now();
        if (wait > 0) await patience.sleep(wait);
        if (request.signal?.aborted) {
          throw new LlmError("분석이 중간에 멈췄어요.", "aborted");
        }
        if (quiet) throw new LlmError("모델이 제때 답하지 않았어요.", "unavailable");

        try {
          const reply = await llm.complete(request);
          // Answered after all: whatever refused us has passed, and the next
          // refusal is worth waiting out again.
          exhausted = false;
          quiet = false;
          return reply;
        } catch (error) {
          if (!(error instanceof LlmError)) throw error;

          // The client's own timeout: `aborted`, but not by the caller.
          if (error.kind === "aborted" && !request.signal?.aborted) {
            timeouts += 1;
            if (timeouts > patience.timeoutRetries || quiet) {
              quiet = true;
              // Still a timeout, not a cancellation: every pass treats
              // `aborted` as "stop everything", and an endpoint that went
              // quiet is a batch lost, not a run.
              throw new LlmError("모델이 제때 답하지 않았어요.", "unavailable");
            }
          } else if (error.retryable) {
            refusals += 1;
            if (refusals > patience.retries || exhausted) {
              exhausted = true;
              throw error;
            }
          } else {
            throw error;
          }

          const delay = Math.min(
            patience.baseDelayMs * 2 ** attempt,
            patience.maxDelayMs,
          );
          resumeAt = Math.max(resumeAt, patience.now() + delay);
          patience.onRefused?.(error.kind, attempt + 1, delay);
        }
      }
    },
  };
}
