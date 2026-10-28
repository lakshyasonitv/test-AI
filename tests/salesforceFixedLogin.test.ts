import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * D-65 stage 1 — a login case that signs in with the REAL credentials replays the RECORDED login.
 *
 * The data is the user's real run 2026-10-16T12-47-28 (a Salesforce scratch org with a two-screen
 * login): `auth.loginSteps` exactly as discovery recorded them, and the case's own login exactly as
 * the model wrote it. The compiled IR of that run stopped after "click Log In to Sandbox" — the
 * password was never typed.
 */

const { swapInRecordedLogin, buildLoginPrefix } = await import("../src/stages/ir.js");
const { fixedLoginRun, salesforceFixedLoginEnabled } = await import("../src/stages/salesforceOrgLogin.js");
const { withTargetApp } = await import("../src/runTarget.js");

const ORG = "https://ruby-data-2200-dev-ed.scratch.my.salesforce.com";
const AUTH: any = {
  status: "authenticated",
  url: "https://ruby-data-2200-dev-ed.scratch.lightning.force.com/one/one.app",
  loginUrl: `${ORG}/`,
  loginSteps: [
    { action: "fill", css: "#username", credential: "username" },
    { action: "click", css: "#Login" },
    { action: "waitFor", css: "#password" },
    { action: "fill", css: "#password", credential: "password" },
    { action: "click", css: "#Login" },
  ],
};
const NO_MAP = new Map<string, "username" | "password">();

/** The case's own login as the model wrote it, before grounding cut it short. */
const modelLogin = () => [
  { id: "s1", action: "navigate", target: { url: "/" } },
  { id: "s2", action: "fill", target: { role: "textbox", name: "Username" }, value: "${env:TEST_USERNAME}" },
  { id: "s3", action: "click", target: { role: "button", name: "Log In to Sandbox" } },
  { id: "s4", action: "wait", value: "500" },
  { id: "s5", action: "fill", target: { role: "textbox", name: "Password" }, value: "${env:TEST_PASSWORD}" },
  { id: "s6", action: "click", target: { role: "button", name: "Log In to Sandbox" } },
  { id: "s7", action: "assert", target: { role: "heading", name: "Home" }, assertion: "visible" },
] as any[];

afterEach(() => { delete process.env.SALESFORCE_FIXED_LOGIN; });

describe("swapInRecordedLogin — what replaces what", () => {
  it("the user's real case: its login becomes the recorded two-screen login, its own check is kept", () => {
    const out = swapInRecordedLogin(modelLogin(), AUTH, NO_MAP)!;
    expect(out).not.toBeNull();
    // The recorded login, step for step — including the wait for the password box.
    expect(out.slice(0, 7)).toEqual(buildLoginPrefix(AUTH));
    expect(out.map((s: any) => [s.action, s.target?.css ?? s.target?.name ?? s.target?.url])).toEqual([
      ["navigate", `${ORG}/`],
      ["fill", "#username"],
      ["click", "#Login"],
      ["assert", "#password"],   // visible: waits for screen 2
      ["fill", "#password"],
      ["click", "#Login"],
      ["assert", "#password"],   // hidden: the login landed
      ["assert", "Home"],        // the case's own check, untouched
    ]);
    expect(out[3].assertion).toBe("visible");
    expect(out[6].assertion).toBe("hidden");
    expect(out[4].value).toBe("${env:TEST_PASSWORD}");
    expect(JSON.stringify(out)).not.toMatch(/Log In to Sandbox/);
  });

  it("the truncated shape (username only, no password step) still gets the whole login", () => {
    const steps = modelLogin().slice(0, 4);   // navigate, fill username, click, wait
    const out = swapInRecordedLogin(steps, AUTH, NO_MAP)!;
    expect(out.slice(0, 7)).toEqual(buildLoginPrefix(AUTH));
    expect(out.slice(7).map((s: any) => s.action)).toEqual(["wait"]);
  });

  it("matches a credential fill by the recorded selector too", () => {
    const steps = [
      { id: "s1", action: "fill", target: { css: "#username" }, value: "x" },
      { id: "s2", action: "click", target: { css: "#Login" } },
      { id: "s3", action: "assert", target: { role: "heading", name: "Home" }, assertion: "visible" },
    ] as any[];
    const out = swapInRecordedLogin(steps, AUTH, NO_MAP)!;
    expect(out.map((s: any) => s.id)).toEqual(["auth-0", "auth-1", "auth-2", "auth-3", "auth-4", "auth-5", "auth-6", "s3"]);
  });

  it("leaves the IR alone when there is nothing to swap", () => {
    // No recorded login.
    expect(swapInRecordedLogin(modelLogin(), { status: "login-failed" } as any, NO_MAP)).toBeNull();
    expect(swapInRecordedLogin(modelLogin(), { ...AUTH, loginSteps: [] }, NO_MAP)).toBeNull();
    expect(swapInRecordedLogin(modelLogin(), undefined, NO_MAP)).toBeNull();
    // No credential fill at all.
    expect(swapInRecordedLogin([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "click", target: { role: "button", name: "Log In to Sandbox" } },
    ] as any, AUTH, NO_MAP)).toBeNull();
    // A credential fill with no submit after it: an unrecognised shape.
    expect(swapInRecordedLogin([
      { id: "s1", action: "fill", target: { role: "textbox", name: "Password" }, value: "x" },
      { id: "s2", action: "assert", target: { role: "button", name: "Log In" }, assertion: "visible" },
    ] as any, AUTH, NO_MAP)).toBeNull();
  });

  it("does not mutate the steps it was given", () => {
    const steps = modelLogin();
    const before = JSON.stringify(steps);
    swapInRecordedLogin(steps, AUTH, NO_MAP);
    expect(JSON.stringify(steps)).toBe(before);
  });
});

describe("the gate — off means today's behaviour", () => {
  it("off by default, even on a ticked Salesforce run", () => {
    expect(salesforceFixedLoginEnabled()).toBe(false);
    expect(withTargetApp("salesforce", () => fixedLoginRun())).toBe(false);
  });

  it("on, but the Salesforce box unticked: still off", () => {
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    expect(withTargetApp(null, () => fixedLoginRun())).toBe(false);
  });

  it("only exactly \"true\" turns it on", () => {
    for (const v of ["1", "TRUE", "yes", ""]) {
      process.env.SALESFORCE_FIXED_LOGIN = v;
      expect(withTargetApp("salesforce", () => fixedLoginRun())).toBe(false);
    }
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    expect(withTargetApp("salesforce", () => fixedLoginRun())).toBe(true);
  });

  it("toIR swaps only behind fixedLoginRun() AND a full credential policy, and only when no prefix was added", () => {
    // Source-structure check, the repo's precedent for wiring (salesforceOrgGuard.test.ts): the swap's
    // behaviour is pinned above; what is pinned HERE is that nothing else can reach it.
    const src = readFileSync("src/stages/ir.ts", "utf8");
    const calls = src.split("\n").filter((l) => l.includes("swapInRecordedLogin(") && !l.includes("export function"));
    expect(calls).toHaveLength(1);
    const at = src.indexOf(calls[0]);
    const before = src.slice(Math.max(0, at - 400), at);
    expect(before).toMatch(/\} else if \(fixedLoginRun\(\) && credPolicy === "full"\) \{/);
  });

  it("the IR cache key gains a part only when the fixed login is on", () => {
    const src = readFileSync("src/stages/ir.ts", "utf8");
    // D-70 added "sf-post-login:1" to the same gated list.
    expect(src).toContain('...(fixedLoginRun() ? ["sf-fixed-login:1", "sf-post-login:1"] : [])');
  });

  it("the flag is registered, so a typo refuses to boot", async () => {
    const { BOOLEAN_ENV_FLAGS, findInvalidBooleanFlags } = await import("../src/server/index.js");
    expect(BOOLEAN_ENV_FLAGS).toContain("SALESFORCE_FIXED_LOGIN");
    expect(findInvalidBooleanFlags({ SALESFORCE_FIXED_LOGIN: "truebro" } as any))
      .toEqual([{ name: "SALESFORCE_FIXED_LOGIN", found: "truebro" }]);
  });
});
