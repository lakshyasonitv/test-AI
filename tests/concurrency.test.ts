import { describe, it, expect } from "vitest";
import { Semaphore } from "../src/server/concurrency.js";

/**
 * Slot release, proven the only way that means anything: by showing a LATER task acquires.
 *
 * Asserting "release was called" would pass against a semaphore whose accounting is wrong —
 * the question is never whether the line ran, it is whether the slot came back. Every test
 * here therefore drives a `max: 1` semaphore into the failure mode, then requires a fresh
 * task to run afterwards. If the permit leaked, that task parks forever and the test times
 * out rather than failing cleanly, which is itself the signal.
 *
 * WHY THIS FILE EXISTS. A report of "a run is created, all four phases stay PENDING, and no
 * work starts" is exactly what a leaked permit looks like from the outside: the run exists and
 * is queued, so it emits no stage events at all. The release is inside a `finally`
 * (`concurrency.ts`), so it survives a throw — but nothing pinned that, and "it's in a finally"
 * is a claim about the source, not about the accounting. These pin the accounting.
 */

/** Run a task that is expected to reject, without letting the rejection escape the test. */
const expectReject = async (p: Promise<unknown>) => { await p.catch(() => {}); };

describe("Semaphore releases its slot on every exit path", () => {
  it("releases after a normal return", async () => {
    const sem = new Semaphore(1);
    await sem.run(async () => "first");
    await expect(sem.run(async () => "second")).resolves.toBe("second");
    expect(sem.inFlight).toBe(0);
  });

  it("releases after the task THROWS", async () => {
    const sem = new Semaphore(1);
    await expectReject(sem.run(async () => { throw new Error("boom"); }));
    // The only assertion that matters: the next caller gets in.
    await expect(sem.run(async () => "after-throw")).resolves.toBe("after-throw");
    expect(sem.inFlight).toBe(0);
  });

  it("releases after a synchronous throw before the first await", async () => {
    const sem = new Semaphore(1);
    // A task that throws before yielding never reaches an await point inside itself; the
    // permit is still held across `await task()`, so `finally` must still fire.
    await expectReject(sem.run(() => { throw new Error("sync boom"); }));
    await expect(sem.run(async () => "after-sync-throw")).resolves.toBe("after-sync-throw");
    expect(sem.inFlight).toBe(0);
  });

  it("releases after a TIMEOUT rejection", async () => {
    const sem = new Semaphore(1);
    // The shape the LLM layer produces: a race between the work and a timer, where the timer
    // wins and the whole task rejects.
    const timeout = <T,>(ms: number) => new Promise<T>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(`exceeded ${ms}ms`), { isTimeout: true })), ms));

    await expectReject(sem.run(() => Promise.race([
      new Promise((r) => setTimeout(r, 5_000)),   // work that would outlast the timeout
      timeout(10),
    ])));
    await expect(sem.run(async () => "after-timeout")).resolves.toBe("after-timeout");
    expect(sem.inFlight).toBe(0);
  });

  it("releases after a CANCELLATION (abort) rejection", async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    const cancellable = () => new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("cancelled"), { name: "AbortError" })));
    });
    const running = sem.run(cancellable);
    controller.abort();
    await expectReject(running);

    await expect(sem.run(async () => "after-cancel")).resolves.toBe("after-cancel");
    expect(sem.inFlight).toBe(0);
  });

  it("releases after a quota-style rejection, the failure that prompted this", async () => {
    const sem = new Semaphore(1);
    // What `callWithPool` throws once its retries are spent on an exhausted Gemini quota.
    const quotaError = Object.assign(new Error("429 RESOURCE_EXHAUSTED: quota exceeded"), { status: 429 });
    await expectReject(sem.run(async () => { throw quotaError; }));
    await expect(sem.run(async () => "after-quota")).resolves.toBe("after-quota");
    expect(sem.inFlight).toBe(0);
  });

  it("survives a whole run of failures without leaking capacity", async () => {
    const sem = new Semaphore(2);
    for (let i = 0; i < 20; i++) {
      await expectReject(sem.run(async () => { throw new Error("fail " + i); }));
    }
    // Both slots must still be usable, concurrently.
    let running = 0, peak = 0;
    await Promise.all([0, 1].map(() => sem.run(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    })));
    expect(peak).toBe(2);
    expect(sem.inFlight).toBe(0);
  });
});

describe("Semaphore reports what it is doing", () => {
  it("exposes inFlight, queued and capacity", async () => {
    const sem = new Semaphore(1);
    expect(sem.capacity).toBe(1);
    expect(sem.inFlight).toBe(0);
    expect(sem.queued).toBe(0);

    let release!: () => void;
    const held = sem.run(() => new Promise<void>((r) => { release = r; }));
    await Promise.resolve();
    expect(sem.inFlight).toBe(1);

    // A second caller parks. THIS is the state behind "all four phases stay PENDING": the run
    // exists, holds no slot, and emits nothing until one frees.
    const queuedTask = sem.run(async () => "ran later");
    await Promise.resolve();
    expect(sem.queued).toBe(1);
    expect(sem.inFlight).toBe(1);

    release();
    await held;
    await expect(queuedTask).resolves.toBe("ran later");
    expect(sem.queued).toBe(0);
    expect(sem.inFlight).toBe(0);
  });

  it("hands the permit to a waiter without exceeding capacity", async () => {
    const sem = new Semaphore(1);
    let concurrent = 0, peak = 0;
    const task = async () => {
      concurrent++; peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
    };
    // A failing task interleaved with successful ones must not let a waiter double up: the
    // permit is handed straight over rather than released and re-acquired.
    await Promise.all([
      sem.run(task),
      sem.run(async () => { throw new Error("interleaved failure"); }).catch(() => {}),
      sem.run(task),
      sem.run(task),
    ]);
    expect(peak).toBe(1);
    expect(sem.inFlight).toBe(0);
  });
});
