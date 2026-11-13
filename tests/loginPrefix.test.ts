import { describe, it, expect } from "vitest";
import { buildLoginPrefix, irAlreadyLogsIn, needsLoginPrefix, irLogsInTooLate, dropLateLogin } from "../src/stages/ir.js";
import { selectCases } from "../src/stages/testCases.js";
import { isEnvValueRef } from "../src/stages/credentials.js";
import type { AppModel, AuthOutcome } from "../src/schema/appModel.js";
import type { IR } from "../src/schema/ir.js";
import type { TestCase } from "../src/stages/testCases.js";

/**
 * The login prefix, and the cap that stops the suite becoming all login tests.
 *
 * Both exist because of run 2026-08-22T07-04-23-933Z-04c5704b: discovery signed in, so the
 * AppModel held only `/dashboard`, so the IR was `navigate /dashboard` + `click "Admin"` with no
 * login anywhere. The spec then ran in a fresh browser, `/dashboard` bounced to `/login`, and
 * `final-page.txt` was the login screen.
 */

const LOGIN_URL = "https://app.example/login";

const auth: AuthOutcome = {
  status: "authenticated",
  url: "https://app.example/dashboard",
  loginUrl: LOGIN_URL,
  loginSteps: [
    { action: "fill", css: "#email", credential: "username" },
    { action: "fill", css: 'input[type="password"]', credential: "password" },
    { action: "click", css: "#go" },
  ],
};

const model = (a?: AuthOutcome): AppModel => ({
  baseUrl: "https://app.example",
  pages: [{ url: "https://app.example/dashboard", concepts: [], elements: [] }],
  ...(a ? { auth: a } : {}),
}) as AppModel;

const ir = (steps: any[]): IR => ({
  meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://app.example" },
  steps,
}) as unknown as IR;

describe("buildLoginPrefix", () => {
  it("turns discovery's recorded login into navigate + fills + submit + settle", () => {
    const prefix = buildLoginPrefix(auth);
    expect(prefix.map((s) => s.action)).toEqual(["navigate", "fill", "fill", "click", "assert"]);
    expect(prefix[0].target?.url).toBe(LOGIN_URL);
    // Selectors come from discovery's live-DOM pass, never re-derived from the model.
    expect(prefix[1].target?.css).toBe("#email");
    expect(prefix[2].target?.css).toBe('input[type="password"]');
    expect(prefix[3].target?.css).toBe("#go");
  });

  it("waits for the login to land before the case's own steps run", () => {
    // Regression, run 2026-08-22T16-10-40-756Z-04cfa936: credentials were filled correctly and
    // step-4.png shows the Sign In button STILL SPINNING while the next step had already
    // navigated to /dashboard — which bounced back to /login. The submit was never awaited.
    const prefix = buildLoginPrefix(auth);
    const settle = prefix.at(-1)!;
    expect(settle.action).toBe("assert");
    expect(settle.assertion, "toBeHidden() auto-waits; a fixed sleep cannot cover a slow login")
      .toBe("hidden");
    // Watching the password box specifically: it is the thing that disappears on success, and
    // its selector is already known from the fill step.
    expect(settle.target?.css).toBe('input[type="password"]');
  });

  it("omits the settle step when no password field was recorded", () => {
    const prefix = buildLoginPrefix({
      ...auth, loginSteps: [{ action: "click", css: "#sso" }],
    });
    expect(prefix.some((s) => s.action === "assert")).toBe(false);
  });
});

describe("needsLoginPrefix", () => {
  const c = (over: any) => ({ title: "t", priority: "high", feature: "f", category: "valid", expected: "e", whyItMatters: "w", steps: [], ...over }) as TestCase;

  // The exact table from run 2026-08-22T16-10-40-756Z-04cfa936, where only `valid`/`fromPrompt`
  // cases were signed in: the invalid-input SEARCH and the state-change SIGN-OUT both ran logged
  // out and both failed on the login page.
  it("signs in every case except the ones about the login page", () => {
    expect(needsLoginPrefix(c({ category: "valid", targetUrl: "https://app.example/dashboard" }), auth)).toBe(true);
    expect(needsLoginPrefix(c({ category: "invalid-input", targetUrl: "https://app.example/dashboard" }), auth)).toBe(true);
    expect(needsLoginPrefix(c({ category: "state-change", targetUrl: "https://app.example/dashboard" }), auth)).toBe(true);
    expect(needsLoginPrefix(c({ category: "security-injection", targetUrl: "https://app.example/admin" }), auth)).toBe(true);
    // ...and NOT the login case itself, whatever its category.
    expect(needsLoginPrefix(c({ category: "invalid-input", targetUrl: LOGIN_URL }), auth)).toBe(false);
    expect(needsLoginPrefix(c({ category: "valid", targetUrl: `${LOGIN_URL}?next=%2Fadmin` }), auth)).toBe(false);
  });

  it("defaults to signing in when the case names no target page", () => {
    // A spurious login costs seconds; a missing one fails the whole case.
    expect(needsLoginPrefix(c({ targetUrl: undefined }), auth)).toBe(true);
  });

  it("does nothing unless discovery actually authenticated", () => {
    const t = c({ targetUrl: "https://app.example/dashboard" });
    expect(needsLoginPrefix(t, undefined)).toBe(false);
    expect(needsLoginPrefix(t, { status: "no-gate" })).toBe(false);
    expect(needsLoginPrefix(t, { status: "login-failed", loginUrl: LOGIN_URL })).toBe(false);
  });

});

describe("buildLoginPrefix — values and edge cases", () => {
  it("uses env references, never the literal credential", () => {
    // runs/ is served publicly (TD-14). generator.ts turns these into `process.env.X ?? ""`.
    const prefix = buildLoginPrefix(auth);
    expect(isEnvValueRef(prefix[1].value)).toBe("TEST_USERNAME");
    expect(isEnvValueRef(prefix[2].value)).toBe("TEST_PASSWORD");
  });

  it("emits a keypress when the login form had no submit button", () => {
    const prefix = buildLoginPrefix({
      ...auth,
      loginSteps: [
        { action: "fill", css: "#p", credential: "password" },
        { action: "press", css: "#p", key: "Enter" },
      ],
    });
    // Second-to-last: the settle assert is appended after whatever submits the form.
    expect(prefix.at(-2)).toMatchObject({ action: "press", value: "Enter", target: { css: "#p" } });
    expect(prefix.at(-1)).toMatchObject({ action: "assert", assertion: "hidden" });
  });

  it("produces nothing unless a login actually succeeded", () => {
    expect(buildLoginPrefix(undefined)).toEqual([]);
    expect(buildLoginPrefix({ status: "no-gate" })).toEqual([]);
    expect(buildLoginPrefix({ status: "login-failed", loginUrl: LOGIN_URL })).toEqual([]);
    // Authenticated but with nothing recorded: prepending a bare navigate to /login would strand
    // the test ON the login page, which is worse than not prefixing at all.
    expect(buildLoginPrefix({ status: "authenticated", loginUrl: LOGIN_URL, loginSteps: [] })).toEqual([]);
  });
});

describe("irAlreadyLogsIn", () => {
  it("is true when the IR fills the same password box the prefix would", () => {
    const already = ir([
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { css: 'INPUT[TYPE="PASSWORD"]' }, value: "x" },
    ]);
    expect(irAlreadyLogsIn(already, auth, model(auth))).toBe(true);
  });

  it("is false for an ordinary in-app case", () => {
    const plain = ir([
      { id: "s1", action: "navigate", target: { url: "/dashboard" } },
      { id: "s2", action: "click", target: { role: "button", name: "Admin" } },
    ]);
    expect(irAlreadyLogsIn(plain, auth, model(auth))).toBe(false);
  });
});

/**
 * TD-188. Run 2026-11-13T05-24-54 (learnvibes): the case wrote its own login AFTER clicking
 * "Admin", irAlreadyLogsIn() saw the password fill and skipped the prefix, and the test clicked
 * "Admin" on the login form in a fresh browser. Decided only from where discovery saw each target.
 */
describe("a login the case writes after acting in the app (TD-188)", () => {
  const siteModel = (): AppModel => ({
    baseUrl: "https://app.example",
    auth,
    pages: [
      { url: LOGIN_URL, concepts: [], elements: [
        { role: "textbox", name: "you@example.com", css: "#email" },
        { role: "textbox", name: "Password", css: 'input[type="password"]' },
        { role: "button", name: "Sign In", css: "#go" },
        { role: "link", name: "Help" },
      ] },
      { url: "https://app.example/dashboard", concepts: [], elements: [
        { role: "button", name: "Admin" },
        { role: "link", name: "Help" },
      ] },
    ],
  }) as AppModel;
  const late = () => ir([
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "click", target: { role: "button", name: "Admin" } },
    { id: "s3", action: "fill", target: { role: "textbox", name: "you@example.com" }, value: "${env:TEST_USERNAME}" },
    { id: "s4", action: "fill", target: { css: 'input[type="password"]' }, value: "${env:TEST_PASSWORD}" },
    { id: "s5", action: "click", target: { role: "button", name: "Sign In" } },
    { id: "s6", action: "assert", target: { role: "button", name: "Sign In" }, assertion: "hidden" },
    { id: "s7", action: "click", target: { role: "button", name: "Users" } },
  ]);

  it("does not count as already signed in, so the recorded login is prepended", () => {
    expect(irLogsInTooLate(late(), auth, siteModel())).toBe(true);
    expect(irAlreadyLogsIn(late(), auth, siteModel())).toBe(false);
  });

  it("drops the case's own late login and keeps every other step", () => {
    const x = late();
    expect(dropLateLogin(x, auth, siteModel())).toEqual(["s3", "s4", "s5", "s6"]);
    expect(x.steps.map((s) => s.id)).toEqual(["s1", "s2", "s7"]);
  });

  it("leaves a case that signs in FIRST exactly as it was", () => {
    const first = ir([
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { css: "#email" }, value: "${env:TEST_USERNAME}" },
      { id: "s3", action: "fill", target: { css: 'input[type="password"]' }, value: "${env:TEST_PASSWORD}" },
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
      { id: "s5", action: "click", target: { role: "button", name: "Admin" } },
    ]);
    expect(irAlreadyLogsIn(first, auth, siteModel())).toBe(true);
    expect(dropLateLogin(first, auth, siteModel())).toEqual([]);
    expect(first.steps).toHaveLength(5);
  });

  it("a click on something that is not part of the signed-in app (a 'Sign in' link) keeps the case's own login", () => {
    const viaLink = ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "link", name: "Sign in" } },
      { id: "s3", action: "fill", target: { css: 'input[type="password"]' }, value: "${env:TEST_PASSWORD}" },
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
    ]);
    expect(irAlreadyLogsIn(viaLink, auth, siteModel())).toBe(true);
  });

  it("an element on the login page AND in the app (a shared 'Help' link) is not acting in the app", () => {
    const viaHelp = ir([
      { id: "s1", action: "click", target: { role: "link", name: "Help" } },
      { id: "s2", action: "fill", target: { css: 'input[type="password"]' }, value: "${env:TEST_PASSWORD}" },
    ]);
    expect(irAlreadyLogsIn(viaHelp, auth, siteModel())).toBe(true);
  });

  it("never applies without a recorded login, or on a frontdoor (Salesforce connection) run", () => {
    expect(irLogsInTooLate(late(), undefined, siteModel())).toBe(false);
    expect(irLogsInTooLate(late(), { ...auth, frontdoor: true } as AuthOutcome, siteModel())).toBe(false);
  });
});

describe("selectCases — login-page cap", () => {
  const c = (over: Partial<TestCase>): TestCase => ({
    title: "t", priority: "high", feature: "f", category: "valid",
    expected: "e", whyItMatters: "w", steps: [], ...over,
  }) as TestCase;

  // Four login cases in four DIFFERENT categories is the shape that defeats the existing
  // diversity pass: it dedupes by category, so every one of them survives it.
  const fourLoginCases = [
    c({ title: "Log in with valid credentials", category: "valid", targetUrl: LOGIN_URL }),
    c({ title: "Reject a wrong password", category: "invalid-input", targetUrl: LOGIN_URL }),
    c({ title: "Reject empty fields", category: "empty-boundary", targetUrl: LOGIN_URL }),
    c({ title: "Resist SQL injection at sign in", category: "security-injection", targetUrl: LOGIN_URL }),
  ];
  const appCases = [
    c({ title: "Add a new user from admin", category: "state-change", targetUrl: "https://app.example/admin" }),
    c({ title: "Search the course catalogue", category: "functional-other", targetUrl: "https://app.example/courses" }),
  ];

  it("keeps at most one login case so the app gets the rest of the budget", () => {
    const out = selectCases([...fourLoginCases, ...appCases], 4, LOGIN_URL);
    expect(out.filter((x) => x.targetUrl === LOGIN_URL)).toHaveLength(1);
    expect(out.filter((x) => x.targetUrl !== LOGIN_URL).length).toBeGreaterThanOrEqual(2);
  });

  it("without the cap, all four login cases survive the category-diversity pass", () => {
    // Pins WHY the cap is needed rather than just that it works — if diversity ever starts
    // handling this on its own, this assertion is the one that should fail first.
    const out = selectCases([...fourLoginCases, ...appCases], 4);
    expect(out.filter((x) => x.targetUrl === LOGIN_URL).length).toBeGreaterThan(1);
  });

  it("never drops the user's own login case", () => {
    // "test the login page" must still work: fromPrompt is the anchor selection always keeps.
    const out = selectCases(
      [c({ title: "Log in as an admin", category: "valid", targetUrl: LOGIN_URL, fromPrompt: true }),
        ...fourLoginCases, ...appCases], 3, LOGIN_URL);
    expect(out[0].fromPrompt).toBe(true);
    expect(out[0].targetUrl).toBe(LOGIN_URL);
  });

  it("matches the login page by URL, ignoring query and hash", () => {
    const out = selectCases(
      [c({ title: "Reject a wrong password", category: "invalid-input", targetUrl: `${LOGIN_URL}?next=%2Fadmin` }),
        c({ title: "Reject empty fields", category: "empty-boundary", targetUrl: `${LOGIN_URL}#form` }),
        ...appCases], 4, LOGIN_URL);
    expect(out.filter((x) => (x.targetUrl ?? "").startsWith(LOGIN_URL))).toHaveLength(1);
  });
});
