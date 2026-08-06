import { describe, it, expect, vi } from "vitest";
import { isPureTextAssertion, groundTerminalTextAssertion, runStepLive } from "../src/stages/liveExtend.js";
import { assertionContradictsCase } from "../src/stages/ir.js";
import { llmCacheSet, makeCacheKey } from "../src/kb/llmCache.js";
import type { IR, Step } from "../src/schema/ir.js";
import type { AppModel } from "../src/schema/appModel.js";
import type { TestCase } from "../src/stages/testCases.js";

const step = (o: Partial<Step>): Step => ({ id: "s1", action: "assert", ...o }) as Step;

// runStepLive's fill branch resolves the live element via targetResolver.resolveLive — mocked
// here to a fake Locator whose .fill() calls are recorded, so this test can pin the exact value
// typed without a real browser. vi.hoisted is required because vi.mock factories run before any
// other top-level code, including a plain `const` declaration referenced from inside them.
const { fillSpy } = vi.hoisted(() => ({ fillSpy: vi.fn(async () => {}) }));
vi.mock("../src/stages/targetResolver.js", () => ({
  resolveLive: vi.fn(async () => ({ fill: fillSpy })),
}));

// Regression for run 2026-08-02T18-34-28-317Z-9ef3c101: a compound case's grounding replay
// typed the REAL password into an earlier, deliberately-wrong login attempt because
// runStepLive had no way to know it wasn't the case's final credential attempt. Pins the fix
// at the level it actually lives, not just through the higher-level flow that calls it — a
// prior draft of this fix had `false ?? step.value`, which tsc caught (boolean isn't a valid
// operand there) but a JS-only test would have missed, since `false` short-circuits `&&` chains
// silently rather than falling through `??` to the intended default.
describe("runStepLive — per-attempt credential eligibility", () => {
  const fillStep = (name: string): Step =>
    ({ id: "s1", action: "fill", target: { role: "textbox", name }, value: "WrongPass" }) as Step;
  const creds = { username: "me@real.com", password: "hunter2" };

  it("types the model's own value, not the real credential, when isFinalCredentialAttempt is false", async () => {
    fillSpy.mockClear();
    await runStepLive({} as any, fillStep("Password"), "https://x.example", creds, undefined, "full", false);
    expect(fillSpy).toHaveBeenCalledWith("WrongPass");
  });

  it("substitutes the real credential when isFinalCredentialAttempt is true (or omitted)", async () => {
    fillSpy.mockClear();
    await runStepLive({} as any, fillStep("Password"), "https://x.example", creds, undefined, "full", true);
    expect(fillSpy).toHaveBeenCalledWith("hunter2");

    fillSpy.mockClear();
    await runStepLive({} as any, fillStep("Password"), "https://x.example", creds, undefined, "full");
    expect(fillSpy).toHaveBeenCalledWith("hunter2");   // default preserves every existing call site
  });
});

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
    // replayAndSnapshot's cache key includes the credential policy — default "full" here
    // matches groundTerminalTextAssertion's own default, so existing callers below (which
    // never pass a policy) still hit this seeded entry.
    const seed = (result: Record<string, unknown>, policy: string = "full") =>
      llmCacheSet(makeCacheKey(baseUrl, JSON.stringify(ir.steps.slice(0, -1)), policy), {
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

  // The bug this whole fix closes: an "identifier-only" replay and a "full" replay of the
  // SAME model/prefix type different passwords, so they reach genuinely different pages and
  // must not share a cache entry. Before policy was folded into the key, a "full" replay
  // (login succeeds, no error text) run first could poison the cache for a later
  // "identifier-only" replay of the identical prefix (login rejected, real error text) —
  // silently reviving the exact bug this fix is meant to close, just one layer down.
  it("keys the replay cache by policy, so identifier-only and full do not collide", async () => {
    const { ir, model, seed } = fixture("policy-cache");
    seed({ pageText: "Welcome back, you are logged in successfully" }, "full");
    seed({ pageText: "Some heading\nInvalid login credentials\nFooter" }, "identifier-only");

    const full = await groundTerminalTextAssertion(ir, model, undefined, "full" as any);
    const identifierOnly = await groundTerminalTextAssertion(ir, model, undefined, "identifier-only" as any);

    expect(full.ir.steps.at(-1)!.target!.text).toBe("Welcome back, you are logged in successfully");
    expect(identifierOnly.ir.steps.at(-1)!.target!.text).toBe("Invalid login credentials");
  });
});
