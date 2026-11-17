import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { resolveLive, LONG_NAME_PREFIX } from "../src/stages/targetResolver.js";

// TD-198. eventrix.tech's template card: discovery read its name as "…+1Configure Template", a later
// capture as "…+1Configure TemplateUse". The step named the second; the grounding replay clicked
// before "Use" appeared, matched nothing exactly, and timed out after 30 s. Both resolvers — the
// replay's (targetResolver.ts) and the generated spec's emitted LOCATE_HELPER (generator.ts) — now
// fall back to the long name's first 40 characters, anchored, when nothing matches exactly.
// Executed for real in Chromium, as CLAUDE.md asks of anything that changes the emitted Playwright.

const CARD = "ConferenceTechnical ConferencesTracks, keynote speakers, sponsor tiers, and multi-session agendas.TracksSpeakersSponsors+1Configure Template";
const ASKED = CARD + "Use";
const HTML = `<!doctype html><body>
  <button id="card">${CARD}</button>
  <button id="other">HackathonHackathons and CompetitionsPrize pools, project submissions</button>
  <button id="short">All</button><button>Restore all settings</button>
</body>`;

/** The locate() helper exactly as a generated spec contains it (SCREEN_MODE_ALL_SITES on). */
async function emittedLocate(): Promise<(page: Page, role: string, name: string, nth?: number) => Promise<any>> {
  const { generateSpec } = await import("../src/stages/generator.js");
  const ir: any = { meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "http://x.test" },
    steps: [{ id: "s1", action: "click", target: { role: "button", name: ASKED } }] };
  process.env.SCREEN_MODE_ALL_SITES = "true";
  let spec: string;
  try { spec = generateSpec(ir, "runs/x/artifacts"); } finally { delete process.env.SCREEN_MODE_ALL_SITES; }
  const m = /async function locate\(page, role, name, nth\) \{[\s\S]*?\r?\n\}\r?\n/.exec(spec);
  if (!m) throw new Error("no locate() in the generated spec");
  return new Function(`${m[0]}; return locate;`)();
}

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(HTML);
});
afterAll(async () => { await browser?.close(); });

describe("a long name that changed still finds its element (both resolvers, real browser)", () => {
  it("the replay's resolver reaches the card by its first 40 characters (flag on)", async () => {
    expect(LONG_NAME_PREFIX).toBe(40);
    process.env.SCREEN_MODE_ALL_SITES = "true";
    try {
      const loc = await resolveLive(page, { role: "button", name: ASKED } as any, "click");
      expect(await loc.getAttribute("id")).toBe("card");
    } finally { delete process.env.SCREEN_MODE_ALL_SITES; }
  });

  it("flag off: neither resolver falls back (behaviour and spec bytes as before)", async () => {
    const live = await resolveLive(page, { role: "button", name: ASKED } as any, "click");
    expect(await live.count()).toBe(0);
    const { generateSpec } = await import("../src/stages/generator.js");
    const ir: any = { meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "http://x.test" },
      steps: [{ id: "s1", action: "click", target: { role: "button", name: ASKED } }] };
    expect(generateSpec(ir, "runs/x/artifacts")).not.toContain("TD-198");
  });

  it("the generated spec's locate() does the same", async () => {
    const locate = await emittedLocate();
    const loc = await locate(page, "button", ASKED);
    expect(await loc.count()).toBe(1);
    expect(await loc.getAttribute("id")).toBe("card");
  });

  it("an exact match still wins when there is one", async () => {
    const locate = await emittedLocate();
    expect(await (await locate(page, "button", CARD)).getAttribute("id")).toBe("card");
    expect(await (await resolveLive(page, { role: "button", name: CARD } as any, "click")).getAttribute("id")).toBe("card");
  });

  it("a short name never falls back to a partial match (TD-32 kept)", async () => {
    const locate = await emittedLocate();
    const loc = await locate(page, "button", "Restore");
    expect(await loc.count()).toBe(0);
    const live = await resolveLive(page, { role: "button", name: "Restore" } as any, "click");
    expect(await live.count()).toBe(0);
  });
});
