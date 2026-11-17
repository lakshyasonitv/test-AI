import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { AppModel } from "../src/schema/appModel.js";
import {
  joinVerifiedPrefix, verifiedPrefixHint, swapInRecordedLogin, buildLoginPrefix,
} from "../src/stages/ir.js";
import { credentialFieldMap } from "../src/stages/credentials.js";

// D-85 "keep what worked" and TD-197 (recorded sign-in on every site). Shapes taken from the eventrix.tech
// runs of 2026-11-17, whose attempts are now logged one line each ("[ir] steps: ...").

const s = (id: string, action: string, target: any = {}, value?: string): any => ({ id, action, target, ...(value ? { value } : {}) });

const verified = [
  s("auth-0", "navigate", { url: "https://www.eventrix.tech/login" }),
  s("auth-1", "fill", { css: "#email" }, "${env:TEST_USERNAME}"),
  s("auth-2", "fill", { css: "#password" }, "${env:TEST_PASSWORD}"),
  s("auth-3", "click", { css: 'button[type="submit"]' }),
  s("auth-4", "assert", { css: "#password" }),
  s("s1", "click", { role: "link", name: "Create Event", css: "aside a" }),
  s("s2", "click", { role: "button", name: "Technical Conferences" }),
];

describe("joinVerifiedPrefix", () => {
  it("a continuation is appended after the verified steps, ids renumbered", () => {
    const out = joinVerifiedPrefix(verified, [
      s("s1", "fill", { role: "textbox", name: "Event Title" }, "Jaipur"),
      s("s2", "click", { role: "button", name: "Continue" }),
    ])!;
    expect(out.map((x) => x.id)).toEqual(["auth-0", "auth-1", "auth-2", "auth-3", "auth-4", "s1", "s2", "s3", "s4"]);
    expect(out[7].target?.name).toBe("Event Title");
    expect(out[5].target?.css).toBe("aside a"); // the verified step keeps its grounding
  });

  it("a new attempt that repeats the verified steps keeps only what comes after the last one", () => {
    const out = joinVerifiedPrefix(verified, [
      s("s1", "click", { role: "link", name: "Create Event" }),
      s("s2", "click", { role: "button", name: "Technical Conferences" }),
      s("s3", "fill", { role: "textbox", name: "Event Title" }, "Jaipur"),
    ])!;
    expect(out).toHaveLength(8);
    expect(out[7].target?.name).toBe("Event Title");
  });

  it("an attempt that starts the flow again on another route is left as written", () => {
    expect(joinVerifiedPrefix(verified, [s("s1", "navigate", { url: "/" }), s("s2", "click", { role: "link", name: "Log in" })])).toBeNull();
  });

  it("nothing verified, nothing joined", () => {
    expect(joinVerifiedPrefix([], [s("s1", "click", { role: "button", name: "X" })])).toBeNull();
  });

  it("the retry prompt lists the verified steps and never prints a credential reference as a value", () => {
    const hint = verifiedPrefixHint(verified);
    expect(hint).toContain("KEPT by the system");
    expect(hint).toContain('s2 click button "Technical Conferences"');
    expect(hint).not.toContain("${env:");
  });
});

// Artifact replay: run 4's real model and its attempt-3 sign-in, as logged.
const RUN4 = "runs/2026-11-17T08-17-02-506Z-54df562f/02-appmodel.json";
describe.skipIf(!existsSync(RUN4))("TD-197 on run 2026-11-17T08-17-02 (artifact replay)", () => {
  const model = AppModel.parse(JSON.parse(readFileSync(RUN4, "utf8")));

  it("the model's own sign-in (navigate / → Log in → fill → fill → Enter) becomes the recorded one", () => {
    const attempt3 = [
      s("s1", "navigate", { url: "/" }),
      s("s2", "click", { role: "link", name: "Log in" }),
      s("s3", "fill", { role: "textbox", name: "Email Address" }, "${env:TEST_USERNAME}"),
      s("s4", "fill", { role: "textbox", name: "Password" }, "${env:TEST_PASSWORD}"),
      s("s5", "press", { role: "textbox", name: "Password" }, "Enter"),
      s("s6", "assert", { role: "button", name: "Eventrix" }),
      s("s7", "click", { role: "link", name: "Create Event" }),
    ];
    const out = swapInRecordedLogin(attempt3, model.auth, credentialFieldMap(model));
    expect(out).not.toBeNull();
    const prefix = buildLoginPrefix(model.auth);
    expect(out!.slice(0, prefix.length)).toEqual(prefix);
    expect(out![prefix.length].action).toBe("assert"); // the model's leftover check — ir.ts drops it after the swap
    expect(out!.at(-1)!.target?.name).toBe("Create Event");
  });
});
