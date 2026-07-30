import { describe, it, expect } from "vitest";
import { isPureTextAssertion, groundTerminalTextAssertion } from "../src/stages/liveExtend.js";
import { assertionContradictsCase } from "../src/stages/ir.js";
import { llmCacheSet, makeCacheKey } from "../src/kb/llmCache.js";
import type { IR, Step } from "../src/schema/ir.js";
import type { AppModel } from "../src/schema/appModel.js";
import type { TestCase } from "../src/stages/testCases.js";

const step = (o: Partial<Step>): Step => ({ id: "s1", action: "assert", ...o }) as Step;

describe("isPureTextAssertion", () => {
  it("is true for a text-only visible assertion", () => {
    expect(isPureTextAssertion(step({ target: { text: "Your password is invalid!" }, assertion: "visible" }))).toBe(true);
  });

  it("is true for text-only hidden/text_contains/text_equals", () => {
    for (const assertion of ["hidden", "text_contains", "text_equals"] as const) {
      expect(isPureTextAssertion(step({ target: { text: "x" }, assertion }))).toBe(true);
    }
  });

  it("is false once role or name is present — groundingError already covers that", () => {
    expect(isPureTextAssertion(step({ target: { text: "x", role: "heading", name: "x" }, assertion: "visible" }))).toBe(false);
    expect(isPureTextAssertion(step({ target: { role: "button", name: "Login" }, assertion: "visible" }))).toBe(false);
  });

  it("is false for a non-assert action", () => {
    expect(isPureTextAssertion(step({ action: "click", target: { text: "x" } }))).toBe(false);
  });

  it("is false for url_contains — value-based, not text-based", () => {
    expect(isPureTextAssertion(step({ target: { url: "/x" }, assertion: "url_contains" }))).toBe(false);
  });

  it("is false with no target at all", () => {
    expect(isPureTextAssertion(step({ assertion: "visible" }))).toBe(false);
  });
});

// groundTerminalTextAssertion normally launches a browser. replayAndSnapshot caches its
// result through llmCache first, so seeding that cache under the key it will compute makes
// the whole function run offline — no Chromium, no LLM.
describe("groundTerminalTextAssertion", () => {
  const guess = "Your password is invalid!";

  const fixture = (host: string) => {
    const baseUrl = `https://${host}.example`;
    const ir = {
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl },
      steps: [
        { id: "s1", action: "navigate", target: { url: "/login" } },
        { id: "s2", action: "click", target: { role: "button", name: "Login" } },
        { id: "s3", action: "assert", target: { text: guess }, assertion: "visible" },
      ],
    } as unknown as IR;
    const page = { url: `${baseUrl}/login`, title: "Login", concepts: [], elements: [] };
    const model = { baseUrl, pages: [page] } as unknown as AppModel;
    const seed = (result: Record<string, unknown>) =>
      llmCacheSet(makeCacheKey(baseUrl, JSON.stringify(ir.steps.slice(0, -1))), {
        reachedUrl: page.url, pageModel: page, ...result,
      });
    return { ir, model, seed };
  };

  // llmCache's disk half never expires (only the in-memory copy honours the TTL), so an
  // entry written before pageText existed comes back forever. Without a default, norm()
  // threw on it OUTSIDE this function's try — escaping toIR's retry loop entirely.
  it("degrades to a no-op on a cache entry written before pageText existed", async () => {
    const { ir, model, seed } = fixture("stale-cache");
    seed({}); // no pageText key at all — the old ReplayResult shape

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res).toMatchObject({ grounded: false, corrected: false });
    expect(res.ir.steps.at(-1)!.target!.text).toBe(guess);
  });

  it("corrects a wrong guess to the real line on the page", async () => {
    const { ir, model, seed } = fixture("corrects");
    seed({ pageText: "Some heading\nYour username is invalid!\nFooter" });

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.corrected).toBe(true);
    expect(res.ir.steps.at(-1)!.target!.text).toBe("Your username is invalid!");
  });

  // The correction is length-based, not sentiment-based: on a negative case whose replay
  // actually SUCCEEDED it will happily substitute the success banner, which would be a false
  // pass. ir.ts guards the swap with assertionContradictsCase — this pins the composition,
  // i.e. that the corrected IR is still shaped so that guard can read it.
  it("produces an IR the negative-case guard rejects when the page shows success", async () => {
    const { ir, model, seed } = fixture("false-pass");
    seed({ pageText: "Welcome back, you are logged in successfully" });

    const { ir: reground } = await groundTerminalTextAssertion(ir, model);
    expect(reground.steps.at(-1)!.target!.text).toBe("Welcome back, you are logged in successfully");

    const negative = {
      priority: "high", feature: "Login", steps: ["s"], generatedFrom: "upfront", fromPrompt: false,
      title: "Verify login failure with invalid password", expected: "An error is shown",
      category: "Invalid password",
    } as unknown as TestCase;
    expect(assertionContradictsCase(reground, negative)?.stepIds).toEqual(["s3"]);
  });
});
