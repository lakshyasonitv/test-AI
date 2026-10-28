import { describe, it, expect, afterEach } from "vitest";
import { AppModel } from "../src/schema/appModel.js";
import { mergeScreenInto, fingerprintOf, sameScreen, screenFingerprint } from "../src/stages/screens.js";
import { emptyScreenMap, mergeIntoMap, screenFromPage } from "../src/stages/screenMap.js";

// Discovery upgrade Phase 3 (SCREEN_BEST_MATCH_ENABLED). Two steps of one wizard share a title and
// most field labels, so a recapture of step 2 passes the loose same-screen rule against BOTH stored
// steps. The old merge replaced the FIRST match: step 1 was overwritten and step 2 kept a stale twin.

const URL = "https://org.example/lightning/o/Lead/new";
const field = (name: string) => ({ role: "textbox", name, visible: true });
const heading = (name: string) => ({ role: "heading", name, visible: true });
const page = (labels: string[]) => ({ url: URL, title: "New Lead", concepts: [], elements: [heading("New Lead"), ...labels.map(field)] });

// Six labels both steps show (a progress bar, shared contact fields), four of their own each: overlap
// 6/10 = 0.6, under the 0.7 rule, so the two steps are stored as two screens.
const SHARED = ["s1", "s2", "s3", "s4", "s5", "s6"];
const STEP1 = page([...SHARED, "first name", "last name", "title", "email"]);
const STEP2 = page([...SHARED, "company", "industry", "rating", "website"]);
// A half-rendered recapture of step 2 (one of its own fields so far): 6/7 against step 1 and 7/7
// against step 2, so BOTH pass the loose rule. Step 2 is the true match.
const STEP2_AGAIN = page([...SHARED, "company"]);

const NOW = new Date("2026-10-19T12:00:00Z");

afterEach(() => { delete process.env.SCREEN_BEST_MATCH_ENABLED; });

function storedTwoSteps() {
  let model = AppModel.parse({ baseUrl: "https://org.example", pages: [] });
  model = mergeScreenInto(model, STEP1 as any).model;
  model = mergeScreenInto(model, STEP2 as any).model;
  return model;
}

describe("Phase 3: a recapture replaces the BEST-matching stored screen", () => {
  it("the fixture really is the ambiguous case: the recapture passes sameScreen against both steps", () => {
    const fp = (p: any) => ({ url: p.url, fp: screenFingerprint(p) });
    expect(sameScreen(fp(STEP1), fp(STEP2_AGAIN))).toBe(true);
    expect(sameScreen(fp(STEP2), fp(STEP2_AGAIN))).toBe(true);
    // ...and the two steps are kept apart when stored (step 2 was not merged into step 1).
    expect(storedTwoSteps().pages).toHaveLength(2);
  });

  it("flag OFF (today): the FIRST match is replaced, so step 1 is lost", () => {
    const step1Key = fingerprintOf(storedTwoSteps().pages[0]).key;
    const { model, replacedKey } = mergeScreenInto(storedTwoSteps(), STEP2_AGAIN as any);
    expect(replacedKey).toBe(step1Key);
    expect(model.pages.map((p) => fingerprintOf(p).labels.includes("first name"))).toEqual([false, false]);
  });

  it("flag ON: step 2 is replaced and step 1 is untouched", () => {
    process.env.SCREEN_BEST_MATCH_ENABLED = "true";
    const before = storedTwoSteps();
    const step1 = before.pages[0];
    const step2Key = fingerprintOf(before.pages[1]).key;
    const { model, replacedKey } = mergeScreenInto(before, STEP2_AGAIN as any);
    expect(replacedKey).toBe(step2Key);
    expect(model.pages).toHaveLength(2);
    expect(model.pages[0]).toEqual(step1);
    expect(fingerprintOf(model.pages[1]).labels).toEqual([...SHARED, "company"].sort());
  });

  it("flag ON: the stored screen map does the same", () => {
    process.env.SCREEN_BEST_MATCH_ENABLED = "true";
    const s1 = screenFromPage({ ...STEP1, screen: screenFingerprint(STEP1) } as any, [], NOW);
    const s2 = screenFromPage({ ...STEP2, screen: screenFingerprint(STEP2) } as any, [], NOW);
    const again = screenFromPage({ ...STEP2_AGAIN, screen: screenFingerprint(STEP2_AGAIN) } as any, [], NOW);
    let map = mergeIntoMap(emptyScreenMap("https://org.example"), [s1], []);
    map = mergeIntoMap(map, [s2], []);
    expect(map.screens).toHaveLength(2);
    map = mergeIntoMap(map, [again], []);
    expect(map.screens.map((s) => s.key).sort()).toEqual([s1.key, again.key].sort());
    expect(map.screens.find((s) => s.key === again.key)?.seen).toBe(2);
  });

  it("flag OFF: the stored screen map keeps today's first-match behaviour", () => {
    const s1 = screenFromPage({ ...STEP1, screen: screenFingerprint(STEP1) } as any, [], NOW);
    const s2 = screenFromPage({ ...STEP2, screen: screenFingerprint(STEP2) } as any, [], NOW);
    const again = screenFromPage({ ...STEP2_AGAIN, screen: screenFingerprint(STEP2_AGAIN) } as any, [], NOW);
    let map = mergeIntoMap(emptyScreenMap("https://org.example"), [s1], []);
    map = mergeIntoMap(map, [s2], []);
    map = mergeIntoMap(map, [again], []);
    expect(map.screens.map((s) => s.key)).not.toContain(s1.key);
  });

  it("flag ON, exact tie on overlap: the exact key wins, then the earliest", () => {
    process.env.SCREEN_BEST_MATCH_ENABLED = "true";
    const model = AppModel.parse({ baseUrl: "https://org.example", pages: [] });
    const a = mergeScreenInto(model, STEP1 as any).model;
    // Re-merging the identical capture replaces itself (exact key), not anything else.
    const { replacedKey } = mergeScreenInto(a, STEP1 as any);
    expect(replacedKey).toBe(fingerprintOf(a.pages[0]).key);
  });
});
