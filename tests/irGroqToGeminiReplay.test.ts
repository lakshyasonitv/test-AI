import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { groundingError, crossFormBleedError, clickedElementHiddenAssertion, missingActions } from "../src/stages/ir.js";

// Groq -> Gemini migration (DECISIONS.md D-21): IR generation moved providers, but the
// deterministic grounding gate it must pass — groundingError, crossFormBleedError,
// clickedElementHiddenAssertion, missingActions — is pure code in ir.ts, untouched by that
// move. This replays real Groq-era IR/AppModel pairs (both accepted at generation time: no
// meta.truncated on either) through the CURRENT grounding functions, off disk, at zero API
// cost. It cannot prove a fresh Gemini generation would produce an equally good IR — the
// pipeline needs a live model call for that — but it does prove the acceptance gate itself
// still accepts what it used to accept, i.e. this session's ir.ts changes (the retry loop's
// catch block, TD-03's rate-limit-retry clause, the auth-error fail-fast path) didn't
// regress the checks that decide IR quality regardless of which provider produced the IR.
//
// Fixtures are COPIES of the original runs/<id>/04-ir.json + 03-cases.json, not live paths into
// runs/ itself — runs/ is gitignored and ages off disk (irPostClickReveal.test.ts's replay
// tests hit exactly this: their two source runs are already gone from this checkout). Copying
// the real saved JSON into tests/fixtures/ keeps the "can't drift from what actually happened"
// property while surviving both git and runs/ cleanup.

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

describe("grounding gate — replayed against real Groq-era accepted IRs", () => {
  const cases = [
    { name: "261d4022 (Contact Form)", irPath: "fixtures/irGroqToGeminiReplay/261d4022-04-ir.json", casesPath: "fixtures/irGroqToGeminiReplay/261d4022-03-cases.json" },
    { name: "0b385264 (Navigation)", irPath: "fixtures/irGroqToGeminiReplay/0b385264-04-ir.json", casesPath: "fixtures/irGroqToGeminiReplay/0b385264-03-cases.json" },
  ];

  for (const { name, irPath, casesPath } of cases) {
    it(`${name}: still grounds clean, with no cross-form bleed, hidden-click, or missing-action rejection`, () => {
      const { ir, updatedAppModel } = load(irPath);
      const testCase = load(casesPath).find((c: any) => c.title === ir.meta.title);
      expect(testCase).toBeDefined(); // fixture sanity: the IR's own title must match a real case

      // Both runs' meta.truncated was absent/false at generation time (confirmed against the
      // saved artifact before writing this test) — i.e. toIR's own retry loop accepted these
      // IRs outright. A pass here means the SAME acceptance decision still holds post-refactor.
      expect(ir.meta.truncated).toBeFalsy();

      expect(groundingError(ir, updatedAppModel)).toBeNull();
      expect(crossFormBleedError(ir, updatedAppModel)).toBeNull();
      expect(clickedElementHiddenAssertion(ir, updatedAppModel)).toBeNull();
      expect(missingActions(ir, testCase)).toBeNull();
    });
  }
});
