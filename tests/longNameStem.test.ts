import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolveLive, LONG_NAME_PREFIX, longNameStem } from "../src/stages/targetResolver.js";

// TD-198, as it really happened on eventrix.tech (run 2026-11-17T10-04-17-522Z-2da13778). Discovery names a
// template card by its textContent, which glues the card's blocks together and is cut at 80 characters:
//   "Technical ConferencesTracks, keynote speakers, sponsor tiers, and multi-session "
// while the browser's accessible name puts spaces between the blocks:
//   "Conference Technical Conferences Tracks, keynote speakers, …"
// An exact match finds nothing, so the click timed out in the grounding replay and in the spec. With
// SCREEN_MODE_ALL_SITES on, both resolvers fall back to the long name's first 40 non-space characters,
// anchored, whitespace ignored. Executed for real in Chromium (CLAUDE.md: never trust the emitted string).

const HTML = `<!doctype html><body>
  <button id="card"><span style="display:block">Conference</span><h3>Technical Conferences</h3>
    <p>Tracks, keynote speakers, sponsor tiers, and multi-session agendas.</p><div>Configure Template</div></button>
  <button id="hack"><span style="display:block">Hackathon</span><h3>Hackathons and Competitions</h3>
    <p>Prize pools, project submissions, judging criteria, and tech stacks.</p></button>
  <button>All</button><button>Restore all settings</button>
</body>`;
// What discovery recorded for the card's inner content (glued, cut at 80) and for the whole card (glued).
const INNER = "Technical ConferencesTracks, keynote speakers, sponsor tiers, and multi-session ";
const WHOLE = "ConferenceTechnical ConferencesTracks, keynote speakers, sponsor tiers, and multi-session agendas.Configure Template";

const IR = (name: string): any => ({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "http://x.test" },
  steps: [{ id: "s1", action: "click", target: { role: "button", name } }] });

/** The locate() helper exactly as a generated spec contains it. */
async function emittedLocate(flagOn = true): Promise<(page: Page, role: string, name: string, nth?: number) => Promise<any>> {
  const { generateSpec } = await import("../src/stages/generator.js");
  if (flagOn) process.env.SCREEN_MODE_ALL_SITES = "true";
  let spec: string;
  try { spec = generateSpec(IR(WHOLE), "runs/x/artifacts"); } finally { delete process.env.SCREEN_MODE_ALL_SITES; }
  const m = /async function locate\(page, role, name, nth\) \{[\s\S]*?\r?\n\}\r?\n/.exec(spec);
  if (!m) throw new Error("no locate() in the generated spec");
  return new Function(`${m[0]}; return locate;`)();
}

const withFlag = async <T>(fn: () => Promise<T>): Promise<T> => {
  process.env.SCREEN_MODE_ALL_SITES = "true";
  try { return await fn(); } finally { delete process.env.SCREEN_MODE_ALL_SITES; }
};

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(HTML);
});
afterAll(async () => { await browser?.close(); });

describe("discovery's glued card names reach the card (both resolvers, real Chromium)", () => {
  it("the premise: the glued name matches nothing exactly", async () => {
    expect(await page.getByRole("button", { name: WHOLE, exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: INNER, exact: true }).count()).toBe(0);
    expect(LONG_NAME_PREFIX).toBe(40);
  });

  it("the replay's resolver reaches the card by the whole-card name (flag on)", async () => {
    expect(await (await withFlag(() => resolveLive(page, { role: "button", name: WHOLE } as any, "click"))).getAttribute("id")).toBe("card");
  });

  it("the generated spec's locate() does the same", async () => {
    const locate = await emittedLocate();
    expect(await (await locate(page, "button", WHOLE)).getAttribute("id")).toBe("card");
  });

  it("the two stems are the same expression", () => {
    expect(longNameStem(WHOLE).test("Conference Technical Conferences Tracks, keynote speakers, x")).toBe(true);
    expect(longNameStem(WHOLE).test("Hackathon Hackathons and Competitions")).toBe(false);
  });

  it("an exact match still wins, and a short name never falls back (TD-32 kept)", async () => {
    const locate = await emittedLocate();
    expect(await (await locate(page, "button", "All")).count()).toBe(1);
    expect(await (await locate(page, "button", "Restore")).count()).toBe(0);
    expect(await (await withFlag(() => resolveLive(page, { role: "button", name: "Restore" } as any, "click"))).count()).toBe(0);
  });

  it("flag off: no fallback in the replay, and the spec does not carry the rung", async () => {
    expect(await (await resolveLive(page, { role: "button", name: WHOLE } as any, "click")).count()).toBe(0);
    const { generateSpec } = await import("../src/stages/generator.js");
    expect(generateSpec(IR(WHOLE), "runs/x/artifacts")).not.toContain("TD-198");
    const off = await emittedLocate(false);
    expect(await (await off(page, "button", WHOLE)).count()).toBe(0);
  });

  it("the inner name (cut mid-card) — reported, not guessed", async () => {
    // "Technical ConferencesTracks…" does not start the card's accessible name ("Conference Technical…"),
    // so the anchored stem finds nothing. This is the name run 10-04-17 actually targeted; see TD-198.
    expect(await (await withFlag(() => resolveLive(page, { role: "button", name: INNER } as any, "click"))).count()).toBe(0);
  });
});
