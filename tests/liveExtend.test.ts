import { describe, it, expect, vi } from "vitest";
import { isPureTextAssertion, groundTerminalTextAssertion, runStepLive, findVerbatim } from "../src/stages/liveExtend.js";
import { assertionContradictsCase } from "../src/stages/ir.js";
import { llmCacheSet, makeCacheKey, credentialFingerprint, llmCacheVersion } from "../src/kb/llmCache.js";
// The walk cache is now keyed per-tenant as well as per-policy: two organisations walking the
// same URL must not share an entry. Outside a run this resolves to "env", which is what these
// tests seed under — the same value production uses when no per-org config is active.
import { llmCacheDimension } from "../src/llm/llmContext.js";
// ...and per-LOCALE: a walk snapshots a rendered page, so a walk taken under one locale must
// not be served to a run using another. Outside a run this resolves from RUN_LOCALE and then
// the "en-US" default, which is what these fixtures seed under.
import { localeCacheDimension } from "../src/browserLaunch.js";
import { WALK_CACHE_NS } from "../src/stages/liveExtend.js";
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
    //
    // It also includes a fingerprint of the credential VALUES and lives in its own namespace
    // (TD-85): a walk that failed to sign in and one that succeeded used to share a key, and the
    // disk half of this cache never expires, so the bad snapshot was served forever. These
    // fixtures pass no credentials, hence the "anon" fingerprint.
    const seed = (result: Record<string, unknown>, policy: string = "full") =>
      llmCacheSet(
        makeCacheKey(baseUrl, JSON.stringify(ir.steps.slice(0, -1)), policy, credentialFingerprint(), llmCacheDimension("main"), localeCacheDimension(), llmCacheVersion()),
        { reachedUrl: page.url, pageModel: page, ...result },
        WALK_CACHE_NS,
      );
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

// The real bug this fallback closes, reproduced from runs/2026-08-16T16-07-28-094Z-261d4022/
// cases/case-0: fill a WPForms contact form, click its real Submit button, the site genuinely
// navigates to its own "thank you" page reading "Thanks for contacting us! We will be in touch
// with you shortly." — none of MESSAGE_LIKE's vocabulary, so the keyword scan alone finds
// nothing and the wrong guessed text ("Message sent successfully") was left uncorrected.
describe("groundTerminalTextAssertion — structural diff fallback", () => {
  const guess = "Message sent successfully";
  const navChrome = "[Skip to content]\nMenu\nWho We Are\nServices\nContact Us";

  const fixture = (host: string) => {
    const baseUrl = `https://${host}.example`;
    const ir = {
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl },
      steps: [
        { id: "s1", action: "navigate", target: { url: "/" } },
        { id: "s2", action: "fill", target: { role: "textbox", name: "Name" }, value: "Jane Doe" },
        { id: "s3", action: "fill", target: { role: "textbox", name: "Email *" }, value: "jane@example.com" },
        { id: "s4", action: "click", target: { role: "button", name: "Submit" } },
        { id: "s5", action: "assert", target: { text: guess }, assertion: "visible" },
      ],
    } as unknown as IR;
    const page = { url: `${baseUrl}/`, title: "Home", concepts: [], elements: [] };
    const model = { baseUrl, pages: [page] } as unknown as AppModel;
    const seedAfter = (pageText: string, policy: string = "full") =>
      llmCacheSet(
        makeCacheKey(baseUrl, JSON.stringify(ir.steps.slice(0, -1)), policy, credentialFingerprint(), llmCacheDimension("main"), localeCacheDimension(), llmCacheVersion()),
        { reachedUrl: page.url, pageModel: page, pageText },
        WALK_CACHE_NS,
      );
    const seedBefore = (pageText: string, policy: string = "full") =>
      llmCacheSet(
        makeCacheKey(baseUrl, JSON.stringify(ir.steps.slice(0, -2)), policy, credentialFingerprint(), llmCacheDimension("main"), localeCacheDimension(), llmCacheVersion()),
        { reachedUrl: page.url, pageModel: page, pageText },
        WALK_CACHE_NS,
      );
    return { ir, model, seedAfter, seedBefore };
  };

  it("corrects via the diff when the keyword scan finds nothing", async () => {
    const { ir, model, seedAfter, seedBefore } = fixture("diff-corrects");
    seedBefore(`${navChrome}\nContact Us\nName\nEmail *\nComment or Message`);
    seedAfter(`${navChrome}\nThanks for contacting us! We will be in touch with you shortly.\nClick here to re-submit the form`);

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.corrected).toBe(true);
    expect(res.ir.steps.at(-1)!.target!.text).toBe("Thanks for contacting us! We will be in touch with you shortly.");
  });

  it("drops a diff candidate that also appears on another already-discovered page (chrome)", async () => {
    const { ir, model, seedAfter, seedBefore } = fixture("diff-chrome");
    // Deliberately LONGER than the real confirmation line below — the "prefer longest" diff
    // tie-break would pick this one instead if the chrome filter didn't exclude it first, so
    // this test actually depends on the filter (an earlier draft used a short chrome line and
    // passed even with the filter disabled, because "longest wins" happened to dodge it anyway
    // regardless). Also deliberately avoids every MESSAGE_LIKE keyword (no "please", "success",
    // etc.) — an earlier draft included "please" and the KEYWORD scan grabbed this line
    // directly before the diff path ever ran, testing nothing about the chrome filter at all.
    const cookieBanner = "We use cookies on this site to improve your browsing experience and show you relevant content across our pages";
    (model.pages as any[]).push({
      url: `${model.baseUrl}/blog`, concepts: [],
      markdown: `Recent Posts\nHow to migrate your CRM\n${cookieBanner}`,
    });
    seedBefore(`${navChrome}\nContact Us\nName\nEmail *`);
    // cookieBanner is new relative to beforeText but is chrome (appears on the /blog page
    // too) — it must be excluded, leaving only the real, shorter confirmation line.
    seedAfter(`${navChrome}\n${cookieBanner}\nThanks for contacting us! We will be in touch with you shortly.`);

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.corrected).toBe(true);
    expect(res.ir.steps.at(-1)!.target!.text).toBe("Thanks for contacting us! We will be in touch with you shortly.");
  });

  it("bails out (leaves the assertion as-is) when too many diff candidates survive", async () => {
    const { ir, model, seedAfter, seedBefore } = fixture("diff-noisy");
    seedBefore(navChrome);
    // A wholesale template change — 20 "new" lines, none of them chrome, too noisy to pick
    // among confidently.
    const manyNewLines = Array.from({ length: 20 }, (_, i) => `New unrelated line number ${i}`).join("\n");
    seedAfter(`${navChrome}\n${manyNewLines}`);

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.corrected).toBe(false);
    expect(res.ir.steps.at(-1)!.target!.text).toBe(guess);
  });

  it("still uses the keyword scan first when it finds something (diff is a fallback, not a replacement)", async () => {
    const { ir, model, seedAfter, seedBefore } = fixture("diff-not-needed");
    seedBefore(navChrome);
    // Contains a MESSAGE_LIKE word ("success") — the keyword path should win without ever
    // needing the before-state replay.
    seedAfter(`${navChrome}\nYour message was a success!`);

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.corrected).toBe(true);
    expect(res.ir.steps.at(-1)!.target!.text).toBe("Your message was a success!");
  });
});

// ---------------------------------------------------------------------------
// Near-miss correction — the gap TD-39's fix sits above
// ---------------------------------------------------------------------------
//
// Reported from a real checkout run: the generated test asserted the exact uppercase string
// "THANK YOU FOR YOUR ORDER" while the page read "Thank you for your order!". The flow itself
// worked; only the assertion failed.
//
// The cause was NOT TD-39. The confirm check was `norm(page).includes(norm(guess))` — lowercased
// and whitespace-collapsed, with `includes()` blind to the trailing "!" — so the wrong-cased guess
// passed, was stamped "confirmed against the live page", and shipped verbatim into
// `expect(...).toHaveText("THANK YOU FOR YOUR ORDER")`, which is case-SENSITIVE and exact. The
// validator was more lenient than the thing it validated, and every TD-39 fixture above uses a
// guess that is genuinely ABSENT from the page, so none of them could ever catch this.
describe("groundTerminalTextAssertion — near miss (case/punctuation only)", () => {
  const nearMissFixture = (host: string, guess: string) => {
    const baseUrl = `https://${host}.example`;
    const ir = {
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl },
      steps: [
        { id: "s1", action: "navigate", target: { url: "/" } },
        { id: "s2", action: "click", target: { role: "button", name: "Finish" } },
        { id: "s3", action: "assert", target: { text: guess }, value: guess, assertion: "text_equals" },
      ],
    } as unknown as IR;
    const page = { url: `${baseUrl}/`, title: "Complete", concepts: [], elements: [] };
    const model = { baseUrl, pages: [page] } as unknown as AppModel;
    const seedAfter = (pageText: string, pageTextRaw?: string) =>
      llmCacheSet(
        makeCacheKey(baseUrl, JSON.stringify(ir.steps.slice(0, -1)), "full", credentialFingerprint(), llmCacheDimension("main"), localeCacheDimension(), llmCacheVersion()),
        { reachedUrl: page.url, pageModel: page, pageText, ...(pageTextRaw !== undefined ? { pageTextRaw } : {}) },
        WALK_CACHE_NS,
      );
    return { ir, model, seedAfter };
  };

  it("corrects a case-only mismatch to the page's own spelling", async () => {
    const { ir, model, seedAfter } = nearMissFixture("nm-case", "Thank You For Your Order");
    seedAfter("Checkout: Complete!\nThank you for your order\nYour order has been dispatched");

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.corrected).toBe(true);
    expect(res.ir.steps.at(-1)!.target!.text).toBe("Thank you for your order");
  });

  it("corrects a trailing-punctuation-only mismatch", async () => {
    const { ir, model, seedAfter } = nearMissFixture("nm-punct", "Thank you for your order");
    seedAfter("Checkout: Complete!\nThank you for your order!\nYour order has been dispatched");

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.corrected).toBe(true);
    expect(res.ir.steps.at(-1)!.target!.text).toBe("Thank you for your order!");
  });

  // THE REPORTED FAILURE, end to end.
  it("corrects the reported uppercase-plus-punctuation case", async () => {
    const { ir, model, seedAfter } = nearMissFixture("nm-reported", "THANK YOU FOR YOUR ORDER");
    seedAfter("Checkout: Complete!\nThank you for your order!\nYour order has been dispatched");

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.corrected).toBe(true);
    expect(res.ir.steps.at(-1)!.target!.text).toBe("Thank you for your order!");
  });

  // target.text becomes the LOCATOR and value becomes the COMPARISON (generator.ts) — correcting
  // one without the other emits expect(getByText(A)).toHaveText(B), which looks for one string and
  // asserts a different one.
  it("keeps target.text and value in step", async () => {
    const { ir, model, seedAfter } = nearMissFixture("nm-both", "THANK YOU FOR YOUR ORDER");
    seedAfter("Thank you for your order!");

    const res = await groundTerminalTextAssertion(ir, model);
    const last = res.ir.steps.at(-1)!;
    expect(last.target!.text).toBe("Thank you for your order!");
    expect(last.value).toBe("Thank you for your order!");
  });

  // CSS text-transform: uppercase. innerText (what the corrector used to read) is the RENDERED
  // text and comes back uppercased; textContent (what toHaveText actually reads) does not. Before
  // this fix the corrector's ground truth and the assertion's ground truth were different strings,
  // so the uppercase guess would be confirmed even with the normalisation removed.
  it("corrects to the textContent spelling, not the CSS-uppercased rendered one", async () => {
    const { ir, model, seedAfter } = nearMissFixture("nm-transform", "THANK YOU FOR YOUR ORDER");
    seedAfter(
      "CHECKOUT: COMPLETE!\nTHANK YOU FOR YOUR ORDER!",
      "Checkout: Complete!\nThank you for your order!",
    );

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.corrected).toBe(true);
    expect(res.ir.steps.at(-1)!.target!.text).toBe("Thank you for your order!");
  });

  it("still reports a genuine verbatim match as uncorrected", async () => {
    const { ir, model, seedAfter } = nearMissFixture("nm-verbatim", "Thank you for your order!");
    seedAfter("Checkout: Complete!\nThank you for your order!\nDispatched");

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.grounded).toBe(true);
    expect(res.corrected).toBe(false);
    expect(res.ir.steps.at(-1)!.target!.text).toBe("Thank you for your order!");
  });

  // Additive, not a replacement: text genuinely absent from the page must still fall through to
  // TD-39's keyword scan rather than being swallowed by the near-miss branch.
  it("leaves genuinely-absent text to the TD-39 keyword path", async () => {
    const { ir, model, seedAfter } = nearMissFixture("nm-absent", "Order placed successfully");
    // Deliberately only ONE message-shaped line: an earlier draft also seeded "Checkout:
    // Complete!", which MESSAGE_LIKE matches on "complete" and which the keyword path's
    // closest-to-guess-length tie-break then picked — so the test asserted TD-39's tie-break
    // rather than that the near-miss branch had stayed out of the way.
    seedAfter("Your payment was declined, please try another card");

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.corrected).toBe(true);
    expect(res.ir.steps.at(-1)!.target!.text).toBe("Your payment was declined, please try another card");
  });

  // Backward compatibility: every cache entry written before pageTextRaw existed comes back
  // without it, and the walk cache never expires.
  it("falls back to rendered text when a cached walk predates pageTextRaw", async () => {
    const { ir, model, seedAfter } = nearMissFixture("nm-legacy", "THANK YOU FOR YOUR ORDER");
    seedAfter("Thank you for your order!");

    const res = await groundTerminalTextAssertion(ir, model);
    expect(res.corrected).toBe(true);
    expect(res.ir.steps.at(-1)!.target!.text).toBe("Thank you for your order!");
  });
});

describe("findVerbatim", () => {
  it("recovers the page's own case and punctuation", () => {
    expect(findVerbatim("Thank you for your order!", "THANK YOU FOR YOUR ORDER")).toBe("Thank you for your order!");
    expect(findVerbatim("A\nThank You For Your Order\nB", "thank you for your order")).toBe("Thank You For Your Order");
  });

  it("prefers the tightest matching line over an enclosing block", () => {
    const raw = "Checkout: Complete! Thank you for your order! Dispatched\nThank you for your order!";
    expect(findVerbatim(raw, "THANK YOU FOR YOUR ORDER")).toBe("Thank you for your order!");
  });

  it("handles textContent with no line breaks at all", () => {
    const raw = "Checkout: Complete!Thank you for your order!Your order has been dispatched";
    expect(findVerbatim(raw, "THANK YOU FOR YOUR ORDER")).toBe("Thank you for your order");
  });

  it("returns null when the text is genuinely absent", () => {
    expect(findVerbatim("Your payment was declined", "Thank you for your order")).toBeNull();
    expect(findVerbatim("", "anything")).toBeNull();
    expect(findVerbatim("some page text", "")).toBeNull();
  });
});
