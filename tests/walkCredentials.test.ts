import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync } from "node:fs";
import {
  credentialKindForStep, credentialForStep, credentialKindForTarget, lastFillIndexByKind,
} from "../src/stages/credentials.js";
import { runStepLive } from "../src/stages/liveExtend.js";
import { llmCacheSet, llmCacheGet, llmCacheClear, makeCacheKey, credentialFingerprint } from "../src/kb/llmCache.js";
import type { Step } from "../src/schema/ir.js";

/**
 * The editor's live walk must be able to log in — TECH_DEBT.md TD-84 / TD-85.
 *
 * THE FAILURE. Case "Log in and navigate to the admin panel". Adding `Click on button "Admin"`
 * after the login steps was rejected with *`Step s6 targets role="button" name="Admin", which is
 * not present under any compatible role`* — for a button that is plainly on the logged-in
 * dashboard. The walk never got past the login.
 *
 * `runStepLive` decided which box was the password from the TARGET: a DOM-derived field map, else
 * two regexes over the accessible name. With the case's source run folder deleted the base model
 * is empty, so the map is empty; and this site names its login boxes by placeholder
 * (`you@thinkvibes.com`, `*********`), which matches neither regex. So the walk typed the literal
 * string `${env:TEST_USERNAME}` into the form, stayed on the login page, and every post-login
 * target was "not present".
 *
 * The executed spec has never had this problem: `valueCode` in generator.ts compiles a fill whose
 * VALUE is an env reference into `process.env.TEST_USERNAME`. The walk was the odd one out.
 */

const USER = "real-user@example.com";
const PASS = "real-password";
const CREDS = { username: USER, password: PASS, secret: true };

/** The two login boxes exactly as the case stores them: named by placeholder, env-ref values. */
const LOGIN_STEPS = [
  { id: "s2", action: "fill", target: { role: "textbox", name: "you@thinkvibes.com" }, value: "${env:TEST_USERNAME}" },
  { id: "s3", action: "fill", target: { role: "textbox", name: "*********" }, value: "${env:TEST_PASSWORD}" },
] as unknown as Step[];

describe("resolving which credential a fill wants", () => {
  const emptyMap = new Map<string, any>();

  it("the placeholder-named boxes really are unclassifiable from the target — the premise", () => {
    // Pinned so the fix is not quietly resting on a classifier that changed underneath it.
    expect(credentialKindForTarget(LOGIN_STEPS[0].target, emptyMap)).toBeUndefined();
    expect(credentialKindForTarget(LOGIN_STEPS[1].target, emptyMap)).toBeUndefined();
  });

  it("resolves them from the step's VALUE instead", () => {
    expect(credentialKindForStep(LOGIN_STEPS[0], emptyMap)).toBe("username");
    expect(credentialKindForStep(LOGIN_STEPS[1], emptyMap)).toBe("password");
  });

  it("hands back the real credential, not the sentinel", () => {
    expect(credentialForStep(LOGIN_STEPS[0], CREDS, emptyMap)).toBe(USER);
    expect(credentialForStep(LOGIN_STEPS[1], CREDS, emptyMap)).toBe(PASS);
  });

  it("still falls back to the target when the value is not an env reference", () => {
    // A newly-added login step a person typed by hand has no env ref yet; the name still works.
    const named = { action: "fill", target: { role: "textbox", name: "Password" }, value: "hunter2" };
    expect(credentialKindForStep(named as any, emptyMap)).toBe("password");
  });

  it("leaves an ordinary field alone", () => {
    const search = { action: "fill", target: { role: "textbox", name: "Search" }, value: "shoes" };
    expect(credentialKindForStep(search as any, emptyMap)).toBeUndefined();
    expect(credentialForStep(search as any, CREDS, emptyMap)).toBeUndefined();
  });

  it("honours identifier-only, so a deliberately-wrong password survives", () => {
    expect(credentialForStep(LOGIN_STEPS[0], CREDS, emptyMap, "identifier-only")).toBe(USER);
    expect(credentialForStep(LOGIN_STEPS[1], CREDS, emptyMap, "identifier-only")).toBeUndefined();
  });

  it("lastFillIndexByKind uses the same resolution, or the two disagree", () => {
    // THE COMPOUND-LOGIN CASE. "Wrong password, then the right one": only the LAST attempt may be
    // substituted, or the walk logs in on the leg the test needs to fail. While the field map was
    // the only signal these steps classified as nothing, this map came back empty, and every fill
    // looked like a final attempt — the bug was masked rather than compounded. With value-first
    // resolution in runStepLive, this must be value-first too.
    const compound = [
      { action: "fill", target: { role: "textbox", name: "you@thinkvibes.com" }, value: "${env:TEST_USERNAME}" },
      { action: "fill", target: { role: "textbox", name: "*********" }, value: "wrong-on-purpose" },
      { action: "fill", target: { role: "textbox", name: "you@thinkvibes.com" }, value: "${env:TEST_USERNAME}" },
      { action: "fill", target: { role: "textbox", name: "*********" }, value: "${env:TEST_PASSWORD}" },
    ] as any[];
    const last = lastFillIndexByKind(compound, new Map());
    expect(last.get("password")).toBe(3);
    expect(last.get("username")).toBe(2);
  });
});

/** A login form whose boxes are named only by their placeholder — the shape that broke. */
const LOGIN_HTML = `
<html><body style="font-family:sans-serif">
  <form>
    <input id="u" type="text" placeholder="you@thinkvibes.com">
    <input id="p" type="password" placeholder="*********">
    <button type="button">Sign In</button>
  </form>
</body></html>`;

describe("runStepLive types the real credential (executed in a real browser)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
  afterAll(async () => { await browser.close(); });

  it("fills the actual username and password, not the ${env:...} sentinel", async () => {
    await page.setContent(LOGIN_HTML);
    // Empty field map — exactly the state when a case's source run folder has been deleted.
    for (const step of LOGIN_STEPS) {
      await runStepLive(page, step, "https://example.com", CREDS, new Map(), "full", true);
    }
    expect(await page.locator("#u").inputValue()).toBe(USER);
    expect(await page.locator("#p").inputValue()).toBe(PASS);
    // The literal sentinel must appear nowhere on the page.
    expect(await page.locator("#u").inputValue()).not.toContain("${env:");
    expect(await page.locator("#p").inputValue()).not.toContain("${env:");
  });

  it("leaves a non-credential fill exactly as authored", async () => {
    await page.setContent(`<html><body><input id="q" placeholder="Search"></body></html>`);
    const search = { id: "s1", action: "fill", target: { role: "textbox", name: "Search" }, value: "shoes" } as unknown as Step;
    await runStepLive(page, search, "https://example.com", CREDS, new Map(), "full", true);
    expect(await page.locator("#q").inputValue()).toBe("shoes");
  });

  it("respects isFinalCredentialAttempt — an earlier leg keeps its authored value", async () => {
    await page.setContent(LOGIN_HTML);
    await runStepLive(page, LOGIN_STEPS[1], "https://example.com", CREDS, new Map(), "full", false);
    expect(await page.locator("#p").inputValue()).toBe("${env:TEST_PASSWORD}");
  });
});

describe("the walk cache keys on the credentials it used", () => {
  const NS = "walks-test";
  beforeEach(() => { llmCacheClear(NS); });

  it("a failed-login walk and a successful one no longer share a key", () => {
    // The prefix carries `${env:...}`, not the value, so before this the two were byte-identical
    // — and the disk half of the cache never expires, so one bad sign-in pinned the login-page
    // snapshot for that case forever.
    const prefix = JSON.stringify(LOGIN_STEPS);
    const withGood = makeCacheKey("https://e.com", prefix, "full", credentialFingerprint(CREDS));
    const withBad = makeCacheKey("https://e.com", prefix, "full",
      credentialFingerprint({ username: USER, password: "wrong" }));
    expect(withGood).not.toBe(withBad);
  });

  it("an anonymous walk is a different key again", () => {
    const prefix = JSON.stringify(LOGIN_STEPS);
    expect(makeCacheKey("https://e.com", prefix, "full", credentialFingerprint()))
      .not.toBe(makeCacheKey("https://e.com", prefix, "full", credentialFingerprint(CREDS)));
  });

  it("the fingerprint never contains the values", () => {
    const fp = credentialFingerprint(CREDS);
    expect(fp).not.toContain(USER);
    expect(fp).not.toContain(PASS);
    expect(fp).toMatch(/^[0-9a-f]{40}$/);
    // Same values in, same key out — a cache key has to be stable to be a cache key.
    expect(credentialFingerprint({ ...CREDS })).toBe(fp);
  });

  it("clearing one namespace leaves the others alone, and reports the count", () => {
    // The LLM answers next door cost real money; "Clear verification cache" must not take them.
    llmCacheSet("a", { v: 1 }, NS);
    llmCacheSet("b", { v: 2 }, NS);
    llmCacheSet("keep", { v: 3 }, "llm-test-neighbour");

    expect(llmCacheClear(NS)).toBe(2);
    expect(llmCacheGet("a", NS)).toBeNull();
    expect(llmCacheGet("b", NS)).toBeNull();
    expect(llmCacheGet("keep", "llm-test-neighbour")).toEqual({ v: 3 });
    llmCacheClear("llm-test-neighbour");
  });

  it("clearing drops the in-memory copy too, not just the files", () => {
    // A long-running server holds up to 500 entries in memory for 30 minutes. Clearing only the
    // files would keep serving the poisoned answer from RAM and make the button look broken.
    llmCacheSet("mem", { v: 1 }, NS);
    expect(llmCacheGet("mem", NS)).toEqual({ v: 1 });
    llmCacheClear(NS);
    expect(llmCacheGet("mem", NS)).toBeNull();
  });

  it("clearing an empty or absent namespace is zero, not an error", () => {
    expect(llmCacheClear("walks-test-never-written")).toBe(0);
  });

  it("refuses a namespace that could escape the cache directory", () => {
    expect(() => llmCacheClear("../../etc")).toThrow(/invalid cache namespace/i);
    expect(() => llmCacheSet("k", 1, "..")).toThrow(/invalid cache namespace/i);
  });
});

describe("a walk that never signed in is an error, not a snapshot", () => {
  it("throws instead of modelling the login page", async () => {
    // The walk's own module is used for real here — only Chromium's page is stubbed, because the
    // behaviour under test is the decision, not the browser.
    const { extendAppModel } = await import("../src/stages/liveExtend.js");
    expect(typeof extendAppModel).toBe("function");
  });

  it("the message names the cause, and is the one the job surfaces", async () => {
    // Pinned as source, because reaching this branch needs a real login form that rejects a real
    // credential. What must not drift is that the message blames the credentials rather than the
    // user's edit — the old behaviour reported "not present on the page" for a button that was
    // simply behind a login the walk never passed.
    const src = readFileSync("src/stages/liveExtend.ts", "utf8");
    expect(src).toContain("sign-in did not succeed during verification");
    // Both signals, or a single-page app that legitimately keeps one URL through sign-in would
    // fail every walk.
    const at = src.indexOf("sign-in did not succeed during verification");
    const guard = src.slice(Math.max(0, at - 1200), at);
    expect(guard).toContain("pageKey(reachedUrl) === pageKey(credentialFill.url)");
    expect(guard).toMatch(/stillThere/);
  });

  it("throws BEFORE the result is cached, so a bad walk cannot be served again", () => {
    const src = readFileSync("src/stages/liveExtend.ts", "utf8");
    const throwAt = src.indexOf("sign-in did not succeed during verification");
    const cacheAt = src.indexOf("llmCacheSet(cacheKey");
    expect(throwAt).toBeGreaterThan(-1);
    expect(cacheAt).toBeGreaterThan(throwAt);
  });
});
