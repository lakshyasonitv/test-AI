import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { isHealable, selfHealDefault } from "../src/stages/heal.js";
import { IR } from "../src/schema/ir.js";
import type { Diagnosis } from "../src/stages/failureAnalysis.js";

/**
 * Self-heal must be asked for, and must not be spent on a refusal it cannot change — TD-83.
 *
 * WHAT IT WAS. `selfHeal` defaulted to `true` in two separately-hardcoded places
 * (`orchestrator.ts`'s fallback and `/api/health`'s advertised default), so every run healed
 * whether or not anyone asked. A heal re-runs the whole case in a real browser AND regenerates
 * the IR, so the user watched the tests run a second time after the run looked finished — and
 * `suiteRunner` emitted nothing at all while doing it. The only trace was a "Fixed
 * automatically" badge, shown only on success.
 */

const diag = (over: Partial<Diagnosis> = {}): Diagnosis => ({
  failingStepId: "s2",
  category: "element_missing",
  explanation: "e",
  suggestedFix: "f",
  ...over,
} as Diagnosis);

const irWith = (meta: Record<string, unknown> = {}) => IR.parse({
  meta: {
    feature: "f", title: "t", priority: "high", sourcePrompt: "p",
    baseUrl: "https://e.com", ...meta,
  },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "click", target: { role: "button", name: "Add User" } },
  ],
});

describe("selfHealDefault", () => {
  const ORIGINAL = process.env.SELF_HEAL_DEFAULT;
  beforeEach(() => { delete process.env.SELF_HEAL_DEFAULT; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SELF_HEAL_DEFAULT;
    else process.env.SELF_HEAL_DEFAULT = ORIGINAL;
  });

  it("is OFF unless explicitly enabled — a heal is a whole extra run, it should be asked for", () => {
    expect(selfHealDefault()).toBe(false);
    process.env.SELF_HEAL_DEFAULT = "false";
    expect(selfHealDefault()).toBe(false);
    process.env.SELF_HEAL_DEFAULT = "1";
    expect(selfHealDefault()).toBe(false);   // the exact string, like every other flag here
    process.env.SELF_HEAL_DEFAULT = "true";
    expect(selfHealDefault()).toBe(true);
  });

  it("is read at call time, so the server and the orchestrator cannot disagree", () => {
    process.env.SELF_HEAL_DEFAULT = "true";
    expect(selfHealDefault()).toBe(true);
    process.env.SELF_HEAL_DEFAULT = "false";
    expect(selfHealDefault()).toBe(false);
  });
});

describe("isHealable", () => {
  it("still heals what heal exists for — an element that was there and is now gone", () => {
    expect(isHealable(diag({ category: "element_missing" }), irWith())).toBe(true);
    expect(isHealable(diag({ category: "selector_changed" }), irWith())).toBe(true);
  });

  it("does not heal a category a re-snapshot cannot address", () => {
    expect(isHealable(diag({ category: "timeout" }), irWith())).toBe(false);
    // Both failures in run 2026-09-06T15-42-48-000Z-61e01731 were exactly this: category
    // "timeout" with a null failingStepId, which is why no heal ran there at all.
    expect(isHealable(diag({ category: "timeout", failingStepId: null }), irWith())).toBe(false);
  });

  it("does not heal when the failing step is the entry navigate (or unknown)", () => {
    expect(isHealable(diag({ failingStepId: "s1" }), irWith())).toBe(false);
    expect(isHealable(diag({ failingStepId: null }), irWith())).toBe(false);
    expect(isHealable(diag({ failingStepId: "nope" }), irWith())).toBe(false);
  });

  it("NEVER heals an IR truncated by a rejected navigate URL — the point of this change", () => {
    // A navigate-url rejection is the guard refusing an invented route. Re-snapshotting cannot
    // make a route real: toIR applies the same deterministic guard to the new model and reaches
    // the same verdict, at ~3.8k prompt tokens — and attemptHeal then discards the result
    // anyway, because a heal that truncates is not a heal.
    const truncated = irWith({ truncated: true, truncationKind: "navigate-url" });
    expect(isHealable(diag({ category: "element_missing" }), truncated)).toBe(false);
    expect(isHealable(diag({ category: "selector_changed" }), truncated)).toBe(false);
  });

  it("decides from the STRUCTURED kind, never from the prose note", () => {
    // `truncationNote` is `ungrounded.message` — prose written for a model, and partly shaped by
    // page text. Branching on its wording is the failure CLAUDE.md's central rule and TD-01
    // record. A note that says "navigate" with no structured kind must NOT block a heal.
    const proseOnly = irWith({
      truncated: true,
      truncationNote: 'Step s4 navigates to "/s/", which is not a page or link destination…',
    });
    expect(isHealable(diag(), proseOnly)).toBe(true);
  });

  it("a truncation of a DIFFERENT kind is still healable", () => {
    // Only the deterministic route refusal is excluded. A missing element found during grounding
    // can genuinely be there after a fresh snapshot.
    expect(isHealable(diag(), irWith({ truncated: true, truncationKind: "role-name" }))).toBe(true);
  });

  it("an untruncated IR is unaffected by the new field", () => {
    expect(isHealable(diag(), irWith({ truncationKind: "navigate-url" }))).toBe(true);
  });

  it("truncationKind is additive — every IR already on disk still parses", () => {
    const old = IR.safeParse({
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://e.com" },
      steps: [{ id: "s1", action: "navigate", target: { url: "/" } }],
    });
    expect(old.success).toBe(true);
    expect(old.success && old.data.meta.truncationKind).toBeUndefined();
  });
});

/**
 * The visibility half of TD-83, pinned on both sides.
 *
 * `suiteRunner` emits the fields and `public/app.js` reads them, and nothing executes that pair —
 * driving `runSuite` needs five mocks. So this asserts the two ends agree by NAME (renaming
 * `healing` to `isHealing` on one side is exactly how the demo-critical line would silently stop
 * rendering) and executes the renderer itself against a stub element.
 */
describe("the retry line the user actually sees", () => {
  const SUITE = readFileSync("src/stages/suiteRunner.ts", "utf8");
  const APP = readFileSync("public/app.js", "utf8");

  it("suiteRunner emits the fields app.js reads", () => {
    for (const field of ["healing", "healAttempt", "healMax", "healsUsedInRun"]) {
      expect(SUITE, `suiteRunner.ts no longer emits ${field}`).toContain(`${field}:`);
      expect(APP, `app.js no longer reads ${field}`).toContain(`.${field}`);
    }
  });

  it("emits the heal event BEFORE attempting the heal, not after", () => {
    // The whole point is saying it while it happens. Emitting on completion would leave the
    // second browser run just as unexplained as it was.
    const emitAt = SUITE.indexOf("healing: true");
    const attemptAt = SUITE.indexOf("await attemptHeal(");
    expect(emitAt).toBeGreaterThan(-1);
    expect(attemptAt).toBeGreaterThan(emitAt);
  });

  it("does NOT emit the primary-case-only 'heal' stage from the suite path", () => {
    // heal.ts documents that the "heal" StageName drives a primary-only phase tracker in app.js;
    // a suite case emitting it would corrupt that tracker.
    expect(SUITE).not.toMatch(/emit\(\s*runId,\s*["']heal["']/);
  });

  it("renders the note, and clears it rather than leaving a stale one", () => {
    const at = APP.indexOf("function setSuiteRetryNote(");
    expect(at).toBeGreaterThan(-1);
    let depth = 0, end = -1;
    for (let k = APP.indexOf("{", at); k < APP.length; k++) {
      if (APP[k] === "{") depth++;
      else if (APP[k] === "}" && --depth === 0) { end = k + 1; break; }
    }
    // A stub element: just enough DOM for the function under test, so this executes the shipped
    // code rather than a description of it.
    const made: any[] = [];
    const doc = { createElement: () => { const el: any = { className: "", textContent: "", remove() { el.removed = true; } }; made.push(el); return el; } };
    const item: any = {
      children: [] as any[],
      appendChild(el: any) { this.children.push(el); },
      querySelector(sel: string) { return this.children.find((c: any) => `.${c.className}` === sel) ?? null; },
    };
    const setNote = new Function("document", `${APP.slice(at, end)}\nreturn setSuiteRetryNote;`)(doc);

    setNote(item, "Attempt 2 of 2 — retrying with a fresh page snapshot");
    expect(item.children).toHaveLength(1);
    expect(item.children[0].className).toBe("hrow-meta");   // existing class, rule 3
    expect(item.children[0].textContent).toContain("Attempt 2 of 2");

    // Updating reuses the node rather than stacking a second one.
    setNote(item, "Retry 1: failed");
    expect(item.children).toHaveLength(1);
    expect(item.children[0].textContent).toBe("Retry 1: failed");

    // null removes it, so a reused row cannot inherit a previous case's note.
    setNote(item, null);
    expect(item.children[0].removed).toBe(true);
  });
});
