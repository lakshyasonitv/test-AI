import { describe, it, expect } from "vitest";
import {
  credentialFieldsNeeded, promptCarriesCredentials, applyCredentials, isEnvValueRef,
  credentialEnvVars, credentialKindForTarget, redactCredentials, REDACTED,
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
