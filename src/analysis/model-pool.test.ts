import { describe, expect, it } from "vitest";

import { LlmError, type Llm, type LlmReply, type LlmRequest } from "@/lib/llm/types";

import { patientLlm, provenLlm, runInOrder } from "./model-pool";
import { STALE_AFTER_MS } from "./run-store";

/**
 * Several model calls at once, and waiting out a refusal.
 *
 * No timing budget anywhere in this file: the machine that runs it is busy, and
 * a test that says "faster than 200 ms" is a test that fails on a slow Tuesday.
 * Concurrency is asserted by counting how many calls were in flight together,
 * which is a fact about the code rather than about the clock.
 */

const reply = (text: string): LlmReply => ({
  text,
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5 },
  finishReason: "stop",
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("runInOrder", () => {
  it("hands results back in the order of the items, not the order they finished", async () => {
    // Later items finish first.
    const slots = await runInOrder([1, 2, 3, 4, 5, 6, 7, 8], 4, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, (9 - item) * 2));
      return item * 10;
    });
    expect(slots.map((slot) => (slot.ran ? slot.value : null))).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80,
    ]);
  });

  it("keeps at most `limit` in flight, and uses all of them", async () => {
    let inFlight = 0;
    let peak = 0;
    await runInOrder(Array.from({ length: 20 }, (_, i) => i), 5, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(peak).toBe(5);
  });

  it("sends the first item alone, so a key that is wrong costs one request", async () => {
    const started: number[] = [];
    let firstDone = false;
    const sawFirstDone: boolean[] = [];
    await runInOrder([0, 1, 2, 3], 4, async (item) => {
      started.push(item);
      sawFirstDone.push(firstDone);
      await tick();
      if (item === 0) firstDone = true;
    });
    expect(started).toEqual([0, 1, 2, 3]);
    // Everything after the first was launched only once the first had finished.
    expect(sawFirstDone).toEqual([false, true, true, true]);
  });

  it("widens at once when the caller already knows the key works", async () => {
    let inFlight = 0;
    const seen: number[] = [];
    await runInOrder(
      [0, 1, 2, 3],
      4,
      async () => {
        inFlight += 1;
        seen.push(inFlight);
        await tick();
        inFlight -= 1;
      },
      () => true,
      false,
    );
    expect(Math.max(...seen)).toBe(4);
  });

  it("remembers whether the model has ever answered", async () => {
    const llm = provenLlm({ complete: async () => reply("ok") });
    expect(llm.proven).toBe(false);
    await llm.complete({ messages: [] });
    expect(llm.proven).toBe(true);

    const refusing = provenLlm({
      complete: () => Promise.reject(new LlmError("401", "auth", 401)),
    });
    await expect(refusing.complete({ messages: [] })).rejects.toBeInstanceOf(LlmError);
    expect(refusing.proven).toBe(false);
  });

  it("stops launching at the first no, and says which items never ran", async () => {
    const slots = await runInOrder([0, 1, 2, 3, 4], 2, async (item) => item, (index) => index < 2);
    expect(slots.map((slot) => slot.ran)).toEqual([true, true, false, false, false]);
  });

  it("re-throws a failure only after everything in flight has settled", async () => {
    const settled: number[] = [];
    await expect(
      runInOrder([0, 1, 2], 3, async (item) => {
        await tick();
        if (item === 1) throw new Error("boom");
        await tick();
        settled.push(item);
      }),
    ).rejects.toThrow("boom");
    expect(settled).toContain(0);
  });
});

describe("patientLlm", () => {
  /** A model that answers from a script, one entry per call. */
  const scripted = (script: (() => LlmReply)[]) => {
    const requests: LlmRequest[] = [];
    const llm: Llm = {
      complete(request) {
        requests.push(request);
        const next = script.shift();
        if (!next) throw new Error("대본에 없는 호출이에요.");
        try {
          return Promise.resolve(next());
        } catch (error) {
          return Promise.reject(error);
        }
      },
    };
    return { llm, requests };
  };

  /** A clock that only moves when somebody sleeps on it. */
  const fakeTime = () => {
    let now = 0;
    const waits: number[] = [];
    return {
      waits,
      now: () => now,
      sleep: async (ms: number) => {
        waits.push(ms);
        now += ms;
      },
    };
  };

  const refused = () => {
    throw new LlmError("429", "rate_limit", 429);
  };

  it("waits out a rate limit and asks again, instead of losing the batch", async () => {
    const time = fakeTime();
    const { llm, requests } = scripted([refused, refused, () => reply("ok")]);
    const patient = patientLlm(llm, { ...time });

    const answer = await patient.complete({ messages: [] });
    expect(answer.text).toBe("ok");
    expect(requests).toHaveLength(3);
    // Doubling waits, starting from the base.
    expect(time.waits).toEqual([2_000, 4_000]);
  });

  it("gives up after its retries and passes the refusal up unchanged", async () => {
    const time = fakeTime();
    const { llm, requests } = scripted([refused, refused, refused]);
    const patient = patientLlm(llm, { ...time, retries: 2 });

    await expect(patient.complete({ messages: [] })).rejects.toMatchObject({
      kind: "rate_limit",
    });
    expect(requests).toHaveLength(3);
  });

  it("never retries a wrong key", async () => {
    const time = fakeTime();
    const { llm, requests } = scripted([
      () => {
        throw new LlmError("401", "auth", 401);
      },
    ]);
    const patient = patientLlm(llm, { ...time });

    await expect(patient.complete({ messages: [] })).rejects.toMatchObject({ kind: "auth" });
    expect(requests).toHaveLength(1);
    expect(time.waits).toEqual([]);
  });

  it("treats the client's own timeout as the endpoint going quiet, not as a cancellation", async () => {
    // `client.ts` reports its two-minute timeout as `aborted`, the same kind a
    // caller's cancellation has. Passes stop everything on `aborted`, so one
    // slow answer used to end a whole pass.
    const time = fakeTime();
    const timedOut = () => {
      throw new LlmError("timeout", "aborted");
    };
    const { llm, requests } = scripted([timedOut, () => reply("ok")]);
    const answer = await patientLlm(llm, { ...time }).complete({ messages: [] });
    expect(answer.text).toBe("ok");
    expect(requests).toHaveLength(2);

    // And when it keeps timing out, it is reported as unavailable — a lost
    // batch — rather than as a cancellation of the run.
    const always = scripted([timedOut, timedOut]);
    await expect(
      patientLlm(always.llm, { ...time, retries: 1 }).complete({ messages: [] }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("does not retry when the caller is the one who gave up", async () => {
    const time = fakeTime();
    const controller = new AbortController();
    controller.abort();
    const { llm, requests } = scripted([() => reply("never")]);

    await expect(
      patientLlm(llm, { ...time }).complete({ messages: [], signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(requests).toHaveLength(0);
  });

  it("stops waiting for the rest of the run once one call has run out of retries", async () => {
    // A spending cap answers 429 exactly like a rate limit, and the client
    // cannot tell them apart. Waiting thirty seconds per batch for a provider
    // that has already refused five times made a 32 s re-read take 330 s.
    const time = fakeTime();
    const { llm, requests } = scripted([refused, refused, refused, refused]);
    const patient = patientLlm(llm, { ...time, retries: 2 });

    await expect(patient.complete({ messages: [] })).rejects.toMatchObject({ kind: "rate_limit" });
    const waitsSpent = time.waits.length;
    expect(requests).toHaveLength(3);

    // The next caller is refused once and told at once — no new waiting.
    await expect(patient.complete({ messages: [] })).rejects.toMatchObject({ kind: "rate_limit" });
    expect(requests).toHaveLength(4);
    expect(time.waits.length).toBe(waitsSpent);
  });

  it("is patient again once the provider answers", async () => {
    const time = fakeTime();
    const { llm, requests } = scripted([
      refused,
      refused,
      () => reply("back"),
      refused,
      () => reply("ok"),
    ]);
    const patient = patientLlm(llm, { ...time, retries: 1 });

    await expect(patient.complete({ messages: [] })).rejects.toMatchObject({ kind: "rate_limit" });
    expect((await patient.complete({ messages: [] })).text).toBe("back");
    // Answered, so the next refusal is waited out rather than passed up.
    expect((await patient.complete({ messages: [] })).text).toBe("ok");
    expect(requests).toHaveLength(5);
  });

  it("makes every caller wait once any caller has been refused", async () => {
    // Six workers retrying on their own would keep the provider exactly as busy
    // as the thing it just refused. The pause is shared.
    // A clock that stands still, so the pause is still in force when the
    // second caller arrives.
    const waits: number[] = [];
    const still = {
      now: () => 0,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    };
    const { llm, requests } = scripted([refused, () => reply("a"), () => reply("b")]);
    const patient = patientLlm(llm, still);

    await patient.complete({ messages: [] });
    // A caller that was never refused itself still waits for the shared pause.
    await patient.complete({ messages: [] });
    expect(waits).toEqual([2_000, 2_000]);
    expect(requests).toHaveLength(3);
  });
});

describe("a refusal window, end to end through runInOrder", () => {
  /**
   * A clock that only moves when every caller is waiting on it.
   *
   * Timers resolve in time order, and between two of them every microtask is
   * allowed to settle, so six workers sleeping, answering and being refused
   * all see one consistent `now` — the virtual version of a minute-long run
   * that takes milliseconds of real time.
   */
  const virtualClock = () => {
    let now = 0;
    let order = 0;
    const timers: { at: number; order: number; resolve: () => void }[] = [];
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    return {
      now: () => now,
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          timers.push({ at: now + Math.max(0, ms), order: order++, resolve });
        }),
      async drive(done: () => boolean) {
        for (let guard = 0; guard < 1_000_000 && !done(); guard += 1) {
          await settle();
          if (done() || timers.length === 0) continue;
          timers.sort((a, b) => a.at - b.at || a.order - b.order);
          const next = timers.shift() as (typeof timers)[number];
          now = Math.max(now, next.at);
          next.resolve();
        }
      },
    };
  };

  /**
   * 60 batches, six wide, one-second answers, refused from `from` for `span`
   * milliseconds — the verifier's simulation, run through the real wrapper.
   */
  const simulate = async (
    span: number,
    patience: Partial<Parameters<typeof patientLlm>[1]> = {},
    from = 5_000,
  ) => {
    const clock = virtualClock();
    let calls = 0;
    let refused = 0;
    const provider: Llm = {
      async complete() {
        calls += 1;
        await clock.sleep(1_000);
        const at = clock.now();
        if (at >= from && at < from + span) {
          refused += 1;
          throw new LlmError("429", "rate_limit", 429);
        }
        return reply("ok");
      },
    };
    const patient = patientLlm(provider, { ...patience, now: clock.now, sleep: clock.sleep });

    let finished = false;
    const run = runInOrder(
      Array.from({ length: 60 }, (_, i) => i),
      6,
      async () => {
        try {
          await patient.complete({ messages: [] });
          return true;
        } catch {
          return false;
        }
      },
    ).finally(() => {
      finished = true;
    });
    await clock.drive(() => finished);
    const slots = await run;
    const lost = slots.filter((slot) => !slot.ran || !slot.value).length;
    return { lost, calls, refused, seconds: clock.now() / 1_000 };
  };

  const OLD = { retries: 4, maxDelayMs: 16_000 };

  it("reproduces what the first schedule lost to a window longer than half a minute", async () => {
    // Four retries over thirty seconds, then the breaker: a per-minute quota
    // cost most of a pass.
    expect((await simulate(25_000, OLD)).lost).toBe(0);
    expect((await simulate(35_000, OLD)).lost).toBeGreaterThan(0);
    expect((await simulate(60_000, OLD)).lost).toBeGreaterThan(20);
  });

  it("loses no batch to any window up to a minute", async () => {
    for (const span of [25_000, 35_000, 45_000, 60_000]) {
      const outcome = await simulate(span);
      console.log(`${span / 1000} s window`, { now: outcome, before: await simulate(span, OLD) });
      expect(outcome.lost, `${span / 1000} s window`).toBe(0);
    }
  });

  /**
   * The wrapper as it was before D178, kept only so the simulation below can
   * state the before: a timeout was retried on the refusal schedule, five
   * times, and shared the refusal breaker.
   */
  const previousPatientLlm = (
    llm: Llm,
    clock: { now: () => number; sleep: (ms: number) => Promise<void> },
  ): Llm => {
    let resumeAt = 0;
    let exhausted = false;
    return {
      async complete(request) {
        for (let attempt = 0; ; attempt += 1) {
          const wait = resumeAt - clock.now();
          if (wait > 0) await clock.sleep(wait);
          try {
            const answer = await llm.complete(request);
            exhausted = false;
            return answer;
          } catch (error) {
            const transient =
              error instanceof LlmError && (error.retryable || error.kind === "aborted");
            if (!transient || attempt >= 5 || exhausted) {
              if (transient) exhausted = true;
              throw error;
            }
            resumeAt = Math.max(resumeAt, clock.now() + Math.min(2_000 * 2 ** attempt, 32_000));
          }
        }
      },
    };
  };

  /**
   * An endpoint that accepts every question and never answers: the client
   * gives up after its own 120 s and says `aborted`. `items` calls, six wide,
   * the first alone — a Python model half or a Pass 3, through `runInOrder`.
   */
  const hang = async (items: number, previous: boolean) => {
    const clock = virtualClock();
    let calls = 0;
    const provider: Llm = {
      async complete() {
        calls += 1;
        await clock.sleep(120_000);
        throw new LlmError("모델 응답을 기다리다가 멈췄어요.", "aborted");
      },
    };
    const wrapped = previous
      ? previousPatientLlm(provider, clock)
      : patientLlm(provider, { now: clock.now, sleep: clock.sleep });

    let finished = false;
    const run = runInOrder(
      Array.from({ length: items }, (_, i) => i),
      6,
      async () => {
        try {
          await wrapped.complete({ messages: [] });
          return true;
        } catch {
          return false;
        }
      },
    ).finally(() => {
      finished = true;
    });
    await clock.drive(() => finished);
    const slots = await run;
    return {
      lost: slots.filter((slot) => !slot.ran || !slot.value).length,
      calls,
      seconds: clock.now() / 1_000,
    };
  };

  it("does not sit silent past the stale-run reaper on an endpoint that hangs (D178)", async () => {
    // `run-store.ts` declares a run dead after ten minutes with no event, and
    // the Python model half writes none while it waits.
    const reaperSeconds = STALE_AFTER_MS / 1_000;
    for (const items of [17, 40]) {
      const now = await hang(items, false);
      const before = await hang(items, true);
      console.log(`hung endpoint, ${items} calls`, { now, before });
      expect(before.seconds, `${items} calls, before`).toBeGreaterThan(reaperSeconds);
      expect(now.seconds, `${items} calls`).toBeLessThan(reaperSeconds / 2);
      expect(now.lost).toBe(items);
    }
  });

  it("still asks again after one slow answer, so a single hiccup loses nothing", async () => {
    const clock = virtualClock();
    let calls = 0;
    const provider: Llm = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          await clock.sleep(120_000);
          throw new LlmError("모델 응답을 기다리다가 멈췄어요.", "aborted");
        }
        await clock.sleep(1_000);
        return reply("ok");
      },
    };
    const patient = patientLlm(provider, { now: clock.now, sleep: clock.sleep });
    let finished = false;
    const run = runInOrder(
      Array.from({ length: 12 }, (_, i) => i),
      6,
      async () => {
        try {
          await patient.complete({ messages: [] });
          return true;
        } catch {
          return false;
        }
      },
    ).finally(() => {
      finished = true;
    });
    await clock.drive(() => finished);
    const slots = await run;
    expect(slots.filter((slot) => !slot.ran || !slot.value)).toHaveLength(0);
    expect(calls).toBe(13);
  });

  it("still gives up on a refusal that never ends, once, in about a minute", async () => {
    // A spending cap: every answer is a 429, for ever. The first batch goes
    // alone, waits the whole schedule out, and then the breaker makes every
    // later refusal immediate — so the run ends rather than waiting a minute
    // per batch.
    const outcome = await simulate(Number.POSITIVE_INFINITY, {}, 0);
    const before = await simulate(Number.POSITIVE_INFINITY, OLD, 0);
    console.log("permanent refusal", { now: outcome, before });
    expect(outcome.lost).toBe(60);
    // Six attempts for the first batch, one for each of the other 59.
    expect(outcome.calls).toBe(6 + 59);
    expect(outcome.seconds).toBeLessThan(120);
  });
});
