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

  it("the inner name (cut mid-card, what run 10-23-48 targeted) reaches the card by matching anywhere", async () => {
    // "Technical ConferencesTracks…" does not START the card's accessible name ("Conference Technical…"); its
    // first 40 non-space characters appear inside it. Both resolvers try anchored, then anywhere.
    expect(await (await withFlag(() => resolveLive(page, { role: "button", name: INNER } as any, "click"))).getAttribute("id")).toBe("card");
    const locate = await emittedLocate();
    expect(await (await locate(page, "button", INNER)).getAttribute("id")).toBe("card");
  });

  it("a card that renders AFTER the click is still found: the replay waits for it (run 10-37-57)", async () => {
    const late = await browser.newPage();
    try {
      await late.setContent(`<!doctype html><body><div id="grid"></div><script>
        setTimeout(() => { document.getElementById("grid").innerHTML = '<button id="card"><span style="display:block">Conference</span><h3>Technical Conferences</h3><p>Tracks, keynote speakers, sponsor tiers, and multi-session agendas.</p></button>'; }, 1200);
      </script></body>`);
      const loc = await withFlag(() => resolveLive(late, { role: "button", name: WHOLE + "Use" } as any, "click"));
      expect(await loc.getAttribute("id")).toBe("card");
    } finally { await late.close(); }
  });

  it("forty characters that appear in no name still match nothing", async () => {
    const other = "Technical ConferencesWorkshops, speakers and sessions for the whole week";
    expect(await (await withFlag(() => resolveLive(page, { role: "button", name: other } as any, "click"))).count()).toBe(0);
    const locate = await emittedLocate();
    expect(await (await locate(page, "button", other)).count()).toBe(0);
  });
});
