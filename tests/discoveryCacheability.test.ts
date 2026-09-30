import { describe, it, expect } from "vitest";
import { discoveryIsWorthCaching } from "../src/stages/hybridDiscovery.js";
import type { AppModel } from "../src/schema/appModel.js";

/**
 * Which discovery results may be remembered for `APPMODEL_CACHE_TTL_MS` — TECH_DEBT.md TD-106,
 * filed from "in a few cases it is unable to login".
 *
 * The codebase already had this argument, written against ONE status:
 *
 *   > Never cache a failed login. A failure is usually transient — wrong value typed, the site
 *   > briefly down, a login form that changed — and caching it pins the whole run to a
 *   > login-page-only model, so the immediate retry silently gets the same broken answer without
 *   > even opening a browser.
 *
 * Three sibling paths cached results just as transient and just as unusable. All three produce the
 * reported symptom, and all three persist for thirty minutes, which is what makes it "a few cases"
 * rather than "always":
 *
 *  1. zero elements at the entry page — returns BEFORE the login is attempted
 *  2. `no-credentials` — a credential prompt that timed out; the next run might have someone there
 *  3. `authenticated` with nothing past the login page — claims success, grounds nothing
 *
 * Case 3 is the one worth dwelling on. When the post-login page extracts no elements, `entry` stays
 * the login page and `loginPageModel` stays unset, so the model is `[loginPage]` with
 * `status: "authenticated"`. Downstream trusts that, builds a login prefix, and then cannot ground a
 * single step beyond it — which surfaces as every case truncating, not as a login problem.
 */

const page = (url: string, elements: number) => ({
  url, title: "t",
  elements: Array.from({ length: elements }, (_, i) => ({ role: "button", name: `b${i}` })),
});

const model = (auth: unknown, pages: ReturnType<typeof page>[]): AppModel =>
  ({ baseUrl: "https://app.example", pages, ...(auth ? { auth } : {}) }) as unknown as AppModel;

const LOGIN = "https://app.example/login";

describe("discoveryIsWorthCaching", () => {
  it("caches an ordinary authenticated result — the common case must stay fast", () => {
    const m = model(
      { status: "authenticated", url: "https://app.example/dashboard", loginUrl: LOGIN, loginSteps: [] },
      [page("https://app.example/dashboard", 39), page(LOGIN, 7)],
    );
    expect(discoveryIsWorthCaching(m)).toEqual({ ok: true });
  });

  it("caches a site with no login gate at all", () => {
    expect(discoveryIsWorthCaching(model({ status: "no-gate", url: "https://app.example/" },
      [page("https://app.example/", 28)]))).toEqual({ ok: true });
  });

  it("refuses a failed login — the original rule, kept", () => {
    const r = discoveryIsWorthCaching(model({ status: "login-failed", url: LOGIN }, [page(LOGIN, 7)]));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/retry/i);
  });

  it("refuses `no-credentials`, so a prompt that timed out gets asked again", () => {
    // Observed on disk: run 2026-09-25T20-00-39 — status no-credentials, ONE page, 7 elements.
    // Cached under `site:<url>` (no credential identity), it was served to the next run that also
    // could not supply credentials, without opening a browser.
    const r = discoveryIsWorthCaching(model({ status: "no-credentials", url: LOGIN }, [page(LOGIN, 7)]));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/credentials/i);
  });

  it("refuses a model with no elements anywhere", () => {
    const r = discoveryIsWorthCaching(model({ status: "no-gate", url: "https://app.example/" },
      [page("https://app.example/", 0)]));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/no elements/i);
  });

  it("refuses `authenticated` when every page IS the login page", () => {
    // The dangerous one: it claims success. Login worked, the post-login page came back empty, and
    // the model is just the login page — so the prefix is built and nothing after it can ground.
    const r = discoveryIsWorthCaching(model(
      { status: "authenticated", url: LOGIN, loginUrl: LOGIN, loginSteps: [] }, [page(LOGIN, 7)],
    ));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/past the login page/i);
  });

  it("still caches a genuine single-page app behind a login", () => {
    // Compared on the landed URL, not on page count — one page is legitimate when it is not the
    // login page. A count-based check would have refused this and re-crawled every run.
    expect(discoveryIsWorthCaching(model(
      { status: "authenticated", url: "https://app.example/app", loginUrl: LOGIN, loginSteps: [] },
      [page("https://app.example/app", 31)],
    ))).toEqual({ ok: true });
  });

  it("ignores the hash when comparing against the login url", () => {
    const r = discoveryIsWorthCaching(model(
      { status: "authenticated", url: LOGIN, loginUrl: LOGIN, loginSteps: [] },
      [page(LOGIN + "#top", 7)],
    ));
    expect(r.ok, "a hash on the login url should not read as a different page").toBe(false);
  });

  it("does not throw on a model with no auth field at all", () => {
    expect(discoveryIsWorthCaching(model(null, [page("https://app.example/", 12)]))).toEqual({ ok: true });
  });
});

describe("the rule is applied at every cache write, not just one", () => {
  const SRC = new URL("../src/stages/hybridDiscovery.ts", import.meta.url);

  it("has no cache write left that bypasses discoveryIsWorthCaching", async () => {
    // The defect was three write sites and one guard. A new `cacheSet(siteCacheKey(...))` added
    // without the check would reintroduce it while every unit test above still passed.
    const src = await import("node:fs").then((fs) => fs.readFileSync(SRC, "utf8"));
    const writes = src.match(/cacheSet\(siteCacheKey\(/g) ?? [];
    expect(writes.length, "exactly one guarded write to the site cache is expected").toBe(1);
    expect(src).toContain("const worth = discoveryIsWorthCaching(result);");
    // The empty-entry path must return WITHOUT caching.
    expect(src).toMatch(/the entry page produced no elements, so a retry should try again/);
  });
});
