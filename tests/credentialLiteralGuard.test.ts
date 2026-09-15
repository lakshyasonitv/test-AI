import { describe, it, expect } from "vitest";
import {
  restoreCredentialRefs, isEnvValueRef, envValueRef, credentialFieldMap,
} from "../src/stages/credentials.js";
import { generateSpec } from "../src/stages/generator.js";
import type { Step, IR } from "../src/schema/ir.js";

/**
 * A credential typed into the step editor must never be stored — TECH_DEBT.md TD-67.
 *
 * WHAT HAPPENED. `DECISIONS.md` D-09 ("no secret reaches any persistent store") was designed
 * around the RUN pipeline: a supplied credential becomes an `${env:...}` reference in the IR and
 * the real value only ever enters the Playwright child's environment. The case EDITOR had no such
 * rule. Someone edited the login steps of a saved case and typed their real email and password as
 * step values; the editor accepted them verbatim.
 *
 * Run `2026-09-06T13-05-36-248Z-db2c0b4c`'s stored IR is the evidence:
 *
 *     s2  fill {"role":"textbox","name":"you@thinkvibes.com"}  value "leaked.user@example.com"
 *     s3  fill {"role":"textbox","name":"*********"}           value "leaked-pw"
 *
 * Both went into `test_cases.ir` and into `generated.spec.ts` under `runs/`, which is served over
 * HTTP.
 *
 * NOTE THOSE FIELD NAMES. They are the placeholder text — `you@thinkvibes.com` and `*********` —
 * and match no word list: `credentialKindForTarget`'s name patterns (`/pass/i`, `/user|email|
 * login|account/i`) find neither. A guard built on naming would have missed this exact case. What
 * does catch it is the step's own history: those values WERE `${env:...}` references, put there by
 * the run that produced the case, from the live DOM. That is the primary signal.
 */

const ref = (k: "username" | "password") => envValueRef(k);

/** The two login steps as they were stored BEFORE the person edited them. */
const ORIGINALS: Step[] = [
  { id: "s1", action: "navigate", target: { url: "/login" } },
  { id: "s2", action: "fill", target: { role: "textbox", name: "you@thinkvibes.com" }, value: ref("username") },
  { id: "s3", action: "fill", target: { role: "textbox", name: "*********" }, value: ref("password") },
  { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
] as unknown as Step[];

/** The same steps after the edit — real values typed in, exactly as the run recorded them. */
const EDITED: Step[] = [
  { id: "s1", action: "navigate", target: { url: "/login" } },
  { id: "s2", action: "fill", target: { role: "textbox", name: "you@thinkvibes.com" }, value: "leaked.user@example.com" },
  { id: "s3", action: "fill", target: { role: "textbox", name: "*********" }, value: "leaked-pw" },
  { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },
] as unknown as Step[];

describe("restoreCredentialRefs", () => {
  it("puts both typed credentials back behind env references", () => {
    const out = restoreCredentialRefs(EDITED, ORIGINALS);
    expect(isEnvValueRef(out.steps[1].value)).toBe("TEST_USERNAME");
    expect(isEnvValueRef(out.steps[2].value)).toBe("TEST_PASSWORD");
  });

  it("the literals appear NOWHERE in what would be stored", () => {
    const out = restoreCredentialRefs(EDITED, ORIGINALS);
    const serialised = JSON.stringify(out.steps);
    expect(serialised).not.toContain("leaked.user@example.com");
    expect(serialised).not.toContain("leaked-pw");
  });

  it("keeps the literals available for THIS save's walk, separately", () => {
    // The walk has to actually sign in, so the values cannot simply be discarded on the spot —
    // they are handed back on a different object the caller uses and drops.
    const out = restoreCredentialRefs(EDITED, ORIGINALS);
    expect(out.live[1].value).toBe("leaked.user@example.com");
    expect(out.live[2].value).toBe("leaked-pw");
    expect(out.creds).toEqual({
      username: "leaked.user@example.com", password: "leaked-pw", secret: true,
    });
  });

  it("catches fields whose names match no credential word list — the reported case", () => {
    // Proof the primary signal is the step's history, not naming. Both names here are placeholder
    // text that `credentialKindForTarget` cannot classify.
    expect(/pass/i.test("*********")).toBe(false);
    expect(/user|email|login|account/i.test("you@thinkvibes.com")).toBe(false);
    const out = restoreCredentialRefs(EDITED, ORIGINALS);
    expect(out.note).not.toBe("");
  });

  it("tells the person what happened, in one line", () => {
    const note = restoreCredentialRefs(EDITED, ORIGINALS).note;
    expect(note).toMatch(/asked for when the test runs/i);
    expect(note).toMatch(/never reaches the database/i);
    // The note must not echo the secret back.
    expect(note).not.toContain("leaked-pw");
  });

  it("also catches a NEW step on a recognisably-named credential field", () => {
    // No history to lean on, so the existing classifier does the work — reused, not re-invented.
    const fresh = [
      { id: "n1", action: "fill", target: { role: "textbox", name: "Password" }, value: "hunter2" },
    ] as unknown as Step[];
    const out = restoreCredentialRefs(fresh, []);
    expect(isEnvValueRef(out.steps[0].value)).toBe("TEST_PASSWORD");
  });

  it("uses the DOM's own inputType when a field map is available", () => {
    // The strongest classification there is, and it needs no naming at all.
    const model: any = {
      baseUrl: "https://e.com",
      pages: [{
        url: "https://e.com/login", concepts: [], elements: [],
        forms: [{ fields: [{ name: "*********", inputType: "password" }] }],
      }],
    };
    const map = credentialFieldMap(model);
    const fresh = [
      { id: "n1", action: "fill", target: { role: "textbox", name: "*********" }, value: "hunter2" },
    ] as unknown as Step[];
    expect(isEnvValueRef(restoreCredentialRefs(fresh, [], map).steps[0].value)).toBe("TEST_PASSWORD");
  });

  it("does NOT rewrite a field merely NAMED Email with no history — newsletter, contact, search", () => {
    // The narrowing that matters. `credentialKindForTarget` calls any "Email" field an identifier,
    // which is right inside a login flow and wrong everywhere else. Rewriting a newsletter signup
    // to ${env:TEST_USERNAME} would break a working test to protect something that is not a secret.
    const newsletter = [
      { id: "n1", action: "fill", target: { role: "textbox", name: "Email" }, value: "sub@example.com" },
    ] as unknown as Step[];
    const out = restoreCredentialRefs(newsletter, []);
    expect(out.steps[0].value).toBe("sub@example.com");
    expect(out.note).toBe("");
  });

  it("but DOES rewrite that same field once it has history", () => {
    // Same target, same value — the difference is that this system already classified the field as
    // the identifier box during the run that produced the case.
    const edited = [
      { id: "n1", action: "fill", target: { role: "textbox", name: "Email" }, value: "sub@example.com" },
    ] as unknown as Step[];
    const originals = [
      { id: "n1", action: "fill", target: { role: "textbox", name: "Email" }, value: ref("username") },
    ] as unknown as Step[];
    expect(isEnvValueRef(restoreCredentialRefs(edited, originals).steps[0].value)).toBe("TEST_USERNAME");
  });

  it("leaves ordinary values completely alone", () => {
    const ordinary = [
      { id: "s1", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "test lakshay" },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Search" }, value: "shoes" },
    ] as unknown as Step[];
    const out = restoreCredentialRefs(ordinary, ordinary);
    expect(out.steps).toEqual(ordinary);
    expect(out.note).toBe("");
    expect(out.creds).toBeUndefined();
  });

  it("is idempotent — a step already holding a reference is untouched", () => {
    const out = restoreCredentialRefs(ORIGINALS, ORIGINALS);
    expect(out.steps).toEqual(ORIGINALS);
    expect(out.note).toBe("");
  });
});

describe("the generated spec never carries the literal", () => {
  it("emits a process.env read, not the password", () => {
    const safe = restoreCredentialRefs(EDITED, ORIGINALS).steps;
    const spec = generateSpec({
      meta: { feature: "auth", title: "Login", priority: "high", sourcePrompt: "p", baseUrl: "https://e.com" },
      steps: safe,
    } as IR, "artifacts");

    // `runs/` is served over HTTP (TD-14), so this file must never hold the value.
    expect(spec).not.toContain("leaked.user@example.com");
    expect(spec).not.toContain("leaked-pw");
    expect(spec).toContain("process.env.TEST_USERNAME");
    expect(spec).toContain("process.env.TEST_PASSWORD");
  });
});
