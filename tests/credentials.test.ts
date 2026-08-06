import { describe, it, expect } from "vitest";
import {
  credentialFieldsNeeded, promptCarriesCredentials, applyCredentials, isEnvValueRef,
  credentialEnvVars, credentialKindForTarget, credentialForTarget, redactCredentials, REDACTED,
  wantsRealCredentials, credentialFieldMap, credentialPolicyFor, lastFillIndexByKind,
} from "../src/stages/credentials.js";
import { generateSpec } from "../src/stages/generator.js";
import type { AppModel } from "../src/schema/appModel.js";
import type { TestCase } from "../src/stages/testCases.js";
import type { IR } from "../src/schema/ir.js";

const model = (elements: { role: string; name: string }[], extra: Record<string, unknown> = {}): AppModel =>
  ({ baseUrl: "https://x.example", pages: [{ url: "https://x.example/", concepts: [], elements, ...extra }] }) as AppModel;

const tc = (o: Partial<TestCase>): TestCase =>
  ({ priority: "high", feature: "Login", steps: ["step"], generatedFrom: "upfront", fromPrompt: false,
     title: "t", expected: "e", ...o }) as TestCase;

const loginCase = tc({ title: "Log in with valid credentials", expected: "The user reaches the dashboard" });
const searchCase = tc({ title: "Search for a product", expected: "Results are listed", feature: "Search" });

describe("credentialFieldsNeeded", () => {
  it("asks when a password field was discovered", () => {
    const m = model([{ role: "textbox", name: "username" }, { role: "textbox", name: "password" }]);
    expect(credentialFieldsNeeded(m, [loginCase])).toEqual(["username", "password"]);
  });

  it("asks for an unlabelled password input that DOM discovery typed", () => {
    const m = model([], { forms: [{ fields: [{ inputType: "password", name: "" }] }] });
    expect(credentialFieldsNeeded(m, [loginCase])).toEqual(["username", "password"]);
  });

  // The identifier pattern matches "Login" — without a role filter every site with a login
  // link looked like it needed credentials, and the prompt would fire on nearly every run.
  it("does not treat a 'Login' BUTTON as a field to fill", () => {
    const m = model([{ role: "button", name: "Login" }, { role: "link", name: "My Account" }]);
    expect(credentialFieldsNeeded(m, [searchCase])).toEqual([]);
  });

  // The real shape that motivated the second signal: an SPA landing page whose login form
  // lives behind a link, so discovery sees no textbox at all.
  it("asks when the form is behind a link and the cases are about auth", () => {
    const m = model([{ role: "link", name: "Log in" }, { role: "link", name: "Sign up" }]);
    expect(credentialFieldsNeeded(m, [loginCase])).toEqual(["username", "password"]);
  });

  it("stays quiet when there is a way in but nothing is testing it", () => {
    const m = model([{ role: "link", name: "Log in" }, { role: "textbox", name: "Search" }]);
    expect(credentialFieldsNeeded(m, [searchCase])).toEqual([]);
  });

  it("stays quiet on a site with no login at all", () => {
    expect(credentialFieldsNeeded(model([{ role: "heading", name: "Welcome" }]), [loginCase])).toEqual([]);
  });
});

describe("promptCarriesCredentials", () => {
  it("recognises credentials the user already typed", () => {
    expect(promptCarriesCredentials("login with email a@b.com password hunter2")).toBe(true);
    expect(promptCarriesCredentials("log in using password: s3cret")).toBe(true);
  });

  it("recognises quoted values", () => {
    expect(promptCarriesCredentials("login with username 'myuser123' password 'mypass456'")).toBe(true);
  });

  // Regression: an earlier version matched any word after the keyword, so "the password
  // field" read as a supplied credential and suppressed the prompt on runs that needed it.
  it("does not fire on a prompt that merely mentions passwords", () => {
    expect(promptCarriesCredentials("test the login and signup page")).toBe(false);
    expect(promptCarriesCredentials("check the password field is masked")).toBe(false);
    expect(promptCarriesCredentials("verify the password strength meter")).toBe(false);
    expect(promptCarriesCredentials("test the password-reset flow")).toBe(false);
  });
});

describe("credentialKindForTarget", () => {
  it("prefers password over the broad identifier family", () => {
    expect(credentialKindForTarget({ name: "Password" } as any)).toBe("password");
    expect(credentialKindForTarget({ name: "Email Address" } as any)).toBe("username");
    expect(credentialKindForTarget({ name: "Full Name" } as any)).toBeUndefined();
  });
});

describe("credentialForTarget — policy-aware (liveExtend's in-process replay)", () => {
  const creds = { username: "me@real.com", password: "hunter2" };
  const usernameTarget = { name: "Email Address" } as any;
  const passwordTarget = { name: "Password" } as any;

  // This is the bug the grounding-replay fix closes: without policy awareness here, a live
  // replay of an "identifier-only" case types the REAL password, the login succeeds, and
  // groundTerminalTextAssertion has no error text left to correct its guess against.
  it("withholds the password under identifier-only, so the case's own wrong value survives replay", () => {
    expect(credentialForTarget(passwordTarget, creds, undefined, "identifier-only")).toBeUndefined();
    expect(credentialForTarget(usernameTarget, creds, undefined, "identifier-only")).toBe("me@real.com");
  });

  it("still hands over both fields under full — the common case must not regress", () => {
    expect(credentialForTarget(passwordTarget, creds, undefined, "full")).toBe("hunter2");
    expect(credentialForTarget(usernameTarget, creds, undefined, "full")).toBe("me@real.com");
  });

  it("defaults to full when policy is omitted, matching every pre-existing call site", () => {
    expect(credentialForTarget(passwordTarget, creds)).toBe("hunter2");
  });
});

describe("keeping user credentials off disk", () => {
  const steps = () => [
    { action: "fill", target: { role: "textbox", name: "Email Address" }, value: "placeholder@x.com" },
    { action: "fill", target: { role: "textbox", name: "Password" }, value: "invented" },
    { action: "fill", target: { role: "textbox", name: "Full Name" }, value: "Ada L" },
  ];

  it("writes literals for public demo credentials", () => {
    const s = steps();
    applyCredentials(s, { username: "tomsmith", password: "SuperSecret" });
    expect(s[0].value).toBe("tomsmith");
    expect(s[1].value).toBe("SuperSecret");
    expect(s[2].value).toBe("Ada L");   // not a credential field — left alone
  });

  it("writes env references, never the value, for the user's own credentials", () => {
    const s = steps();
    applyCredentials(s, { username: "me@real.com", password: "hunter2", secret: true });
    expect(JSON.stringify(s)).not.toContain("hunter2");
    expect(JSON.stringify(s)).not.toContain("me@real.com");
    expect(isEnvValueRef(s[0].value)).toBe("TEST_USERNAME");
    expect(isEnvValueRef(s[1].value)).toBe("TEST_PASSWORD");
  });

  // The whole point: runs/ is served publicly, so the spec file must not hold the secret.
  it("emits a process.env read in the generated spec instead of the secret", () => {
    const ir = {
      meta: { feature: "Auth", title: "Login", priority: "high", sourcePrompt: "p", baseUrl: "https://x.example" },
      steps: [
        { id: "s1", action: "navigate", target: { url: "/login" } },
        { id: "s2", action: "fill", target: { role: "textbox", name: "Password" }, value: "${env:TEST_PASSWORD}" },
        { id: "s3", action: "assert", target: { role: "button", name: "Login" }, assertion: "hidden" },
      ],
    } as unknown as IR;

    const spec = generateSpec(ir, "artifacts");
    expect(spec).toContain('process.env.TEST_PASSWORD ?? ""');
    expect(spec).not.toContain("${env:TEST_PASSWORD}");
  });

  it("only honours the two known env vars, so a crafted value can't read others", () => {
    expect(isEnvValueRef("${env:GEMINI_API_KEYS}")).toBeNull();
    expect(isEnvValueRef("${env:PATH}")).toBeNull();
    expect(isEnvValueRef("just a normal value")).toBeNull();
    expect(isEnvValueRef(undefined)).toBeNull();
  });

  // The live replay has to type the REAL values to get past a login, so everything it
  // captures afterwards is contaminated — and that output is cached under runs/_cache and
  // embedded in 04-ir.json, both publicly served.
  it("scrubs secret credentials out of anything a live replay captured", () => {
    const replayed = {
      reachedUrl: "https://x.example/dashboard",
      pageText: "Signed in as me@real.com\nWelcome back",
      pageModel: { url: "https://x.example/dashboard", concepts: [], elements: [{ role: "button", name: "me@real.com" }] },
    };
    const clean = redactCredentials(replayed, { username: "me@real.com", password: "hunter2", secret: true });
    const json = JSON.stringify(clean);
    expect(json).not.toContain("me@real.com");
    expect(json).toContain(REDACTED);
    expect(clean.reachedUrl).toBe("https://x.example/dashboard");   // untouched
  });

  it("leaves public demo credentials alone — they are published on the sites themselves", () => {
    const captured = { pageText: "Signed in as tomsmith" };
    expect(redactCredentials(captured, { username: "tomsmith", password: "SuperSecret" })).toEqual(captured);
    expect(redactCredentials(captured, undefined)).toEqual(captured);
  });

  it("does not shred unrelated text for a very short credential", () => {
    const captured = { pageText: "an ordinary sentence" };
    expect(redactCredentials(captured, { username: "an", password: "x", secret: true })).toEqual(captured);
  });

  it("hands the real values to the test process only for secret credentials", () => {
    expect(credentialEnvVars({ username: "u", password: "p", secret: true }))
      .toEqual({ TEST_USERNAME: "u", TEST_PASSWORD: "p" });
    expect(credentialEnvVars({ username: "tomsmith", password: "public" })).toEqual({});
    expect(credentialEnvVars(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Regressions from run 2026-07-30T15-19-00-537Z-dcd09643, where supplied credentials
// went into the signup form and injection payloads got overwritten with the real email.
// ---------------------------------------------------------------------------

describe("credential substitution is opt-in, per step", () => {
  const secret = { username: "real@user.com", password: "RealPw1", secret: true };
  const login = tc({ title: "Log in with valid credentials", category: "valid" });

  it("substitutes for a valid-login case", () => {
    const steps = [{ action: "fill", target: { name: "Email Address" }, value: "placeholder@x.com" }];
    expect(wantsRealCredentials(login, false)).toBe(true);
    applyCredentials(steps, secret, "full", ["https://x.example/login"]);
    expect(isEnvValueRef(steps[0].value)).toBe("TEST_USERNAME");
  });

  // The fromPrompt case is why credentials get supplied at all — it must use them, unless the
  // prompt already carried its own literal values.
  it("uses supplied credentials for the fromPrompt case, but not when the prompt had its own", () => {
    const p = tc({ title: "Log in as asked", fromPrompt: true, category: "functional-other" });
    expect(wantsRealCredentials(p, false)).toBe(true);
    expect(wantsRealCredentials(p, true)).toBe(false);
  });

  // These are the exact categories that let the old blocklist through.
  it("does NOT substitute for injection, validation or boundary cases", () => {
    for (const category of ["security-injection", "security-xss", "invalid-input", "empty-boundary"] as const) {
      expect(wantsRealCredentials(tc({ title: "t", category }), false)).toBe(false);
    }
  });

  // The run's primary case was signup AND login in one. Its register leg must keep the
  // invented values; a case-level rule cannot express that.
  it("never puts real credentials into a registration leg of the same case", () => {
    const steps = [
      { action: "fill", target: { name: "Email Address" }, value: "invented@example.com" },
      { action: "fill", target: { name: "Password" }, value: "Invented1!" },
      { action: "fill", target: { name: "Email Address" }, value: "placeholder@x.com" },
    ];
    const legs = ["https://x.example/register", "https://x.example/register", "https://x.example/login"];
    applyCredentials(steps, secret, "full", legs);
    expect(steps[0].value).toBe("invented@example.com");   // register leg untouched
    expect(steps[1].value).toBe("Invented1!");
    expect(isEnvValueRef(steps[2].value)).toBe("TEST_USERNAME");  // login leg substituted
  });
});

// ---------------------------------------------------------------------------
// Regression for run 2026-08-02T18-34-28-317Z-9ef3c101 (learnvibes.vercel.app):
// a compound case ("verify invalid login, then verify valid login") got ONE case-level
// "full" policy, so BOTH the valid AND the deliberately-wrong password fills received the
// same real credential. Leg 1's real login succeeded for real, authenticating the session;
// leg 2 then re-navigated to /login, which an auth-guarded site redirects away from an
// already-logged-in session — the email field it needed to fill was never on the page, and
// the test timed out waiting for it. lastFillIndexByKind fixes the LATENT bug (both legs
// getting real creds); it does not by itself fix the redirect (that's the reorder-the-case
// prompt rule) — but without this fix, reordering alone would just move the same "second
// occurrence silently overwritten" problem onto the OTHER leg instead.
// ---------------------------------------------------------------------------

describe("lastFillIndexByKind", () => {
  it("maps a single-login case's kinds to their only index — no change for the common case", () => {
    const steps = [
      { action: "fill", target: { name: "Email Address" } },
      { action: "fill", target: { name: "Password" } },
    ];
    const last = lastFillIndexByKind(steps);
    expect(last.get("username")).toBe(0);
    expect(last.get("password")).toBe(1);
  });

  it("maps a compound two-attempt case's kinds to the SECOND occurrence", () => {
    const steps = [
      { action: "fill", target: { name: "Email Address" }, value: "invalid@example.com" },
      { action: "fill", target: { name: "Password" }, value: "WrongPass" },
      { action: "click", target: { role: "button", name: "Sign In" } },
      { action: "fill", target: { name: "Email Address" }, value: "valid.user@example.com" },
      { action: "fill", target: { name: "Password" }, value: "Password123!" },
    ];
    const last = lastFillIndexByKind(steps);
    expect(last.get("username")).toBe(3);
    expect(last.get("password")).toBe(4);
  });

  it("excludes a registration leg, so it can never be the 'last' occurrence a login leg needs", () => {
    const steps = [
      { action: "fill", target: { name: "Email Address" } },   // register leg
      { action: "fill", target: { name: "Email Address" } },   // login leg
    ];
    const legs = ["https://x.example/register", "https://x.example/login"];
    expect(lastFillIndexByKind(steps, undefined, legs).get("username")).toBe(1);
  });
});

describe("applyCredentials — a compound case only substitutes its FINAL attempt", () => {
  const secret = { username: "lakshya.soni@thinkvibes.com", password: "123456", secret: true };

  // The exact shape from the real failing case: two password fills in one case, policy "full".
  it("leaves the first (deliberately-wrong) attempt untouched and substitutes only the last", () => {
    const steps = [
      { action: "fill", target: { name: "Email Address" }, value: "invalid@example.com" },
      { action: "fill", target: { name: "Password" }, value: "WrongPass" },
      { action: "click", target: { role: "button", name: "Sign In" } },
      { action: "fill", target: { name: "Email Address" }, value: "valid.user@example.com" },
      { action: "fill", target: { name: "Password" }, value: "Password123!" },
    ];
    applyCredentials(steps, secret, "full");
    expect(steps[0].value).toBe("invalid@example.com");   // first attempt: untouched
    expect(steps[1].value).toBe("WrongPass");              // first attempt: untouched
    expect(isEnvValueRef(steps[3].value)).toBe("TEST_USERNAME");   // last attempt: substituted
    expect(isEnvValueRef(steps[4].value)).toBe("TEST_PASSWORD");   // last attempt: substituted
  });
});

// ---------------------------------------------------------------------------
// Regression for run 2026-08-02T11-52-01-198Z-ef0d185b (learnvibes.vercel.app):
// credentials were supplied, and the "Log in with valid credentials" case still typed an
// invented account. That site's login inputs have no label and no name attribute, so their
// accessible name is the PLACEHOLDER — 'you@thinkvibes.com' and '*********'. Neither matches
// the name patterns ("*********" has no letters at all), so both fields were skipped.
// ---------------------------------------------------------------------------

describe("credentialFieldMap — unlabelled login forms", () => {
  // Exactly the shape discovery recorded for that site.
  const unlabelled = {
    baseUrl: "https://x.example",
    pages: [{
      url: "https://x.example/login", concepts: [],
      elements: [
        { role: "textbox", name: "you@thinkvibes.com" },
        { role: "textbox", name: "*********" },
      ],
      forms: [{ fields: [
        { inputType: "email", name: "", placeholder: "you@thinkvibes.com", label: "" },
        { inputType: "password", name: "", placeholder: "*********", label: "" },
      ] }],
    }],
  } as any;

  it("resolves the fields that defeated name matching", () => {
    const map = credentialFieldMap(unlabelled);
    expect(credentialKindForTarget({ name: "you@thinkvibes.com" } as any, map)).toBe("username");
    expect(credentialKindForTarget({ name: "*********" } as any, map)).toBe("password");
  });

  it("substitutes into both, which is the bug the user reported", () => {
    const steps = [
      { action: "fill", target: { role: "textbox", name: "you@thinkvibes.com" }, value: "user@thinkvibes.com" },
      { action: "fill", target: { role: "textbox", name: "*********" }, value: "ValidPass123!" },
    ];
    applyCredentials(steps, { username: "me@real.com", password: "hunter2", secret: true },
      tc({ title: "Log in with valid credentials", category: "valid" }),
      ["https://x.example/login", "https://x.example/login"],
      credentialFieldMap(unlabelled));
    expect(isEnvValueRef(steps[0].value)).toBe("TEST_USERNAME");
    expect(isEnvValueRef(steps[1].value)).toBe("TEST_PASSWORD");
  });

  // An unlabelled type="text" identifier is only findable by its position before the password.
  it("treats a text field immediately before a password field as the identifier", () => {
    const positional = { baseUrl: "https://x.example", pages: [{
      url: "https://x.example/login", concepts: [], elements: [],
      forms: [{ fields: [
        { inputType: "text", name: "", placeholder: "e.g. jsmith", label: "" },
        { inputType: "password", name: "", placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022", label: "" },
      ] }],
    }] } as any;
    const map = credentialFieldMap(positional);
    expect(credentialKindForTarget({ name: "e.g. jsmith" } as any, map)).toBe("username");
  });

  // Don't let the new signal make things worse than the old one.
  it("leaves an unrelated text field alone", () => {
    const withSearch = { baseUrl: "https://x.example", pages: [{
      url: "https://x.example/", concepts: [], elements: [],
      forms: [{ fields: [{ inputType: "text", name: "q", placeholder: "Search products", label: "" }] }],
    }] } as any;
    const map = credentialFieldMap(withSearch);
    expect(credentialKindForTarget({ name: "Search products" } as any, map)).toBeUndefined();
    expect(credentialKindForTarget({ name: "Full Name" } as any, map)).toBeUndefined();
  });

  // Sites that already worked must keep working when DOM discovery found no forms at all.
  it("still falls back to name matching with no forms in the model", () => {
    const noForms = { baseUrl: "https://x.example", pages: [{ url: "https://x.example/", concepts: [], elements: [] }] } as any;
    const map = credentialFieldMap(noForms);
    expect(map.size).toBe(0);
    expect(credentialKindForTarget({ name: "Password" } as any, map)).toBe("password");
    expect(credentialKindForTarget({ name: "Email Address" } as any, map)).toBe("username");
  });
});

// ---------------------------------------------------------------------------
// Regression for run 2026-08-02T12-17-30-348Z-1a9b931d: the "invalid credentials" case
// received the user's REAL account, logged in successfully, was redirected off /login, and
// then failed its own assertion — with the UI blaming the site.
//
// Cause: wantsRealCredentials checked `fromPrompt` BEFORE the category and short-circuited,
// so a negative case that happened to be the literal translation of the request got working
// credentials regardless of intent.
// ---------------------------------------------------------------------------

describe("credentialPolicyFor", () => {
  // The real case-0 from that run.
  const negativeFromPrompt = tc({
    title: "Verify login functionality handles invalid credentials",
    category: "invalid-input", fromPrompt: true,
    steps: ["Fill 'you@thinkvibes.com' with 'nonexistent@user.com'", "Fill '*********' with 'incorrectPassword123'"],
    expected: "An error message is displayed and the user remains on the login page.",
  });

  it("never gives working credentials to a negative case, even when it is the fromPrompt one", () => {
    expect(credentialPolicyFor(negativeFromPrompt, false)).toBe("identifier-only");
  });

  it("keeps giving both fields to a genuine valid-login case", () => {
    expect(credentialPolicyFor(tc({ title: "Log in with valid credentials", category: "valid" }), false)).toBe("full");
  });

  it("touches nothing for empty-field and injection cases", () => {
    expect(credentialPolicyFor(tc({ title: "Submit login with empty email", category: "empty-boundary" }), false)).toBe("none");
    expect(credentialPolicyFor(tc({ title: "SQL injection in login", category: "security-injection" }), false)).toBe("none");
  });

  // The veto. These wordings match the password pattern too, and promoting them would
  // overwrite the deliberately-broken identifier — the same bug, one category over.
  it("vetoes substitution when the IDENTIFIER is the thing under test", () => {
    for (const title of [
      "Malformed email",                              // taxonomy title
      "Login with invalid email and valid password",  // matches the password pattern as well
      "Registration with malformed email address",
      "Login attempt with empty identifier",
    ]) {
      expect(credentialPolicyFor(tc({ title, category: "invalid-input" }), false)).toBe("none");
    }
    // ...including the taxonomy's own intent wording.
    expect(credentialPolicyFor(tc({
      title: "Malformed email", category: "invalid-input",
      expected: "an email without '@'; expect a format validation error",
    }), false)).toBe("none");
  });

  it("still respects credentials the user typed into the prompt", () => {
    const p = tc({ title: "Log in as asked", fromPrompt: true, category: "functional-other" });
    expect(credentialPolicyFor(p, true)).toBe("none");
    expect(credentialPolicyFor(p, false)).toBe("full");
  });

  it("identifier-only substitutes the account but keeps the wrong password", () => {
    const steps = [
      { action: "fill", target: { role: "textbox", name: "Email Address" }, value: "nonexistent@user.com" },
      { action: "fill", target: { role: "textbox", name: "Password" }, value: "incorrectPassword123" },
    ];
    applyCredentials(steps, { username: "me@real.com", password: "hunter2", secret: true }, "identifier-only");
    expect(isEnvValueRef(steps[0].value)).toBe("TEST_USERNAME");
    expect(steps[1].value).toBe("incorrectPassword123");   // the point of the whole test
  });
});
