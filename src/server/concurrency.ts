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

  /** Slots currently held — tasks actually running. */
  get inFlight(): number { return this.active; }

  /** Callers parked waiting for a slot. Non-zero here with `inFlight === max` is the
   *  signature of the "run created, all phases PENDING, nothing starts" report: the run
   *  exists and is queued, so it emits no stage events until a slot frees. */
  get queued(): number { return this.waiters.length; }

  /** The cap this instance was constructed with (`MAX_CONCURRENT_RUNS`). */
  get capacity(): number { return this.max; }

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
      // EVERY exit path releases: normal return, a thrown error, a rejected quota/backoff
      // failure, a timeout that rejects, an abort. `finally` covers all of them because the
      // permit is only ever held across `await task()`. What it CANNOT cover is a task that
      // never settles — a permit is held for as long as the work takes, so a slow run (LLM
      // backoff) or a parked one (credential prompt, case-selection gate) legitimately holds
      // its slot. Those are bounded by their own timeouts, not by this class.
      const next = this.waiters.shift();
      if (next) next();        // hand our permit straight to the next waiter (active unchanged)
      else this.active--;      // nobody waiting — actually release it
    }
  }
}

// The wake-gap case that broke the naive release-then-reacquire version is covered by
// tests/strategy.test.ts (`npm test`).
