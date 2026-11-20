import { describe, it, expect } from "vitest";
import { countPasswordBoxes } from "../src/stages/hybridDiscovery.js";

// TD-195: a sign-in's post-submit redirect landing in the middle of `locator.count()` threw
// "Execution context was destroyed" and ended the sign-in (run 2026-11-17T07-52-12-423Z-75a6f008).

/** A stand-in Page whose count() throws `errors` first, then answers `n`. */
function fakePage(errors: string[], n: number) {
  let waits = 0;
  const page: any = {
    locator: () => ({
      count: async () => {
        const e = errors.shift();
        if (e) throw new Error(e);
        return n;
      },
    }),
    waitForLoadState: async () => { waits++; },
  };
  return { page, waits: () => waits };
}

describe("countPasswordBoxes", () => {
  it("counts again after a navigation destroys the context mid-count", async () => {
    const f = fakePage(["locator.count: Execution context was destroyed, most likely because of a navigation"], 1);
    expect(await countPasswordBoxes(f.page)).toBe(1);
    expect(f.waits()).toBe(1);
  });

  it("answers at once when nothing navigates", async () => {
    const f = fakePage([], 0);
    expect(await countPasswordBoxes(f.page)).toBe(0);
    expect(f.waits()).toBe(0);
  });

  it("rethrows any other error unchanged", async () => {
    const f = fakePage(["Target page, context or browser has been closed"], 1);
    await expect(countPasswordBoxes(f.page)).rejects.toThrow(/has been closed/);
  });

  it("gives up after a few navigations in a row instead of looping forever", async () => {
    const nav = "Execution context was destroyed";
    const f = fakePage([nav, nav, nav, nav, nav], 1);
    await expect(countPasswordBoxes(f.page)).rejects.toThrow(/Execution context/);
  });
});
