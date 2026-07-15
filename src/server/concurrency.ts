/**
 * Caps how many pipelines run at once. Each run launches Chromium (discovery +
 * execution), so uncapped concurrency = one browser per request = OOM and a bigger,
 * pricier box. This is the cheapest cost lever there is: a slot limiter.
 *
 * ponytail: in-process, no deps. Over-cap requests queue and start when a slot frees.
 * Swap for a real distributed queue (SQS/Redis) only when you outgrow one machine —
 * callers just `await run(fn)` either way. See ENTERPRISE.md.
 */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private max: number) {
    if (max < 1) throw new Error("Semaphore: max must be >= 1");
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    // Take a permit if free, else park. A parked caller is resumed by *inheriting* the
    // finishing caller's permit (below), so it must NOT increment here — incrementing
    // after a release-and-reacquire opens a window where a fresh arrival steals the
    // freed slot and concurrency exceeds max.
    if (this.active < this.max) this.active++;
    else await new Promise<void>((r) => this.waiters.push(r));
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next();        // hand our permit straight to the next waiter (active unchanged)
      else this.active--;      // nobody waiting — actually release it
    }
  }
}

// One runnable check: concurrency never exceeds `max`, INCLUDING when a new caller
// arrives in the wake gap between a finish and a parked caller resuming (the case that
// broke the naive release-then-reacquire version). Run directly:
//   node --import tsx src/server/concurrency.ts
if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/server/concurrency.ts")) {
  const sem = new Semaphore(2);
  let running = 0, peak = 0;
  const gates: Array<() => void> = [];              // manually control when each task finishes
  const task = () => sem.run(async () => {
    running++; peak = Math.max(peak, running);
    await new Promise<void>((r) => gates.push(r));
    running--;
  });
  const flush = () => new Promise((r) => setImmediate(r));

  task(); task(); task();          // A,B run; C parks
  await flush();
  gates.shift()!();                // A finishes → should wake C
  task();                          // D arrives in the wake gap — must NOT start a 3rd
  await flush();
  gates.forEach((g) => g()); await flush();

  if (peak !== 2) throw new Error(`FAIL: peak concurrency ${peak}, expected 2`);
  console.log("OK: interleaved arrival in wake gap held cap; peak concurrency =", peak);
}
