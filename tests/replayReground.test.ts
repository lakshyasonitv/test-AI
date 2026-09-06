import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ungroundedStepIndexes, replayRegroundEnabled } from "../src/stages/replay.js";
import { Target, IR } from "../src/schema/ir.js";
import type { IR as IRType } from "../src/schema/ir.js";

/**
 * Replay-time re-grounding — TECH_DEBT.md TD-77, behind `REPLAY_REGROUND` (default OFF).
 *
 * THE UNDERLYING PROBLEM. Grounding writes `css`/`testId` onto a target from the model discovery
 * built. Anything revealed by a CLICK — a modal, a tab, an accordion, the next page of a wizard —
 * was never in that model, so its steps ship with a role and a name and nothing else. At run time
 * they fall back to name and geometry, which is how the New User modal's "Email" step resolved
 * onto the Full Name input on run `2026-09-06T13-05-36-248Z-db2c0b4c` (TD-72).
 *
 * Better resolution (TD-72's fix) helps. Having the real selector helps more, and is what this
 * does: walk the prefix in a real browser, snapshot what is on screen, ground against it. The same
 * deterministic role/name matching `groundingError` already uses — **no LLM calls**, which is the
 * one property a replay must not lose.
 */

const ir = (steps: unknown[]): IRType => ({
  meta: { feature: "f", title: "t", priority: "medium", sourcePrompt: "p", baseUrl: "https://e.com" },
  steps,
} as IRType);

describe("ungroundedStepIndexes — which steps need the live page", () => {
  it("picks the modal steps and nothing else", () => {
    // The real shape from that run: login steps are grounded, the post-click modal steps are not.
    const found = ungroundedStepIndexes(ir([
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Email", css: "#email" }, value: "a@b.c" },
      { id: "s3", action: "click", target: { role: "button", name: "Add New", testId: "add-new" } },
      { id: "s4", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "x" },
      { id: "s5", action: "fill", target: { role: "textbox", name: "Email" }, value: "y" },
    ]));
    expect(found).toEqual([3, 4]);
  });

  it("ignores navigate, wait and page-level assertions", () => {
    expect(ungroundedStepIndexes(ir([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "wait", value: "1000" },
      { id: "s3", action: "assert", assertion: "url_contains", value: "/home" },
    ]))).toEqual([]);
  });

  it("returns nothing for a fully grounded case — the common replay, which must stay free", () => {
    expect(ungroundedStepIndexes(ir([
      { id: "s1", action: "click", target: { role: "button", name: "Go", css: "#go" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Q", testId: "q" }, value: "z" },
    ]))).toEqual([]);
  });
});

describe("the REPLAY_REGROUND flag", () => {
  const ORIGINAL = process.env.REPLAY_REGROUND;
  beforeEach(() => { delete process.env.REPLAY_REGROUND; });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.REPLAY_REGROUND;
    else process.env.REPLAY_REGROUND = ORIGINAL;
  });

  it("is OFF unless explicitly set to true (platform rule 2)", () => {
    expect(replayRegroundEnabled()).toBe(false);
    process.env.REPLAY_REGROUND = "false";
    expect(replayRegroundEnabled()).toBe(false);
    process.env.REPLAY_REGROUND = "1";
    expect(replayRegroundEnabled()).toBe(false);   // only the exact string, like every other flag
    process.env.REPLAY_REGROUND = "true";
    expect(replayRegroundEnabled()).toBe(true);
  });
});

describe("the groundedAt marker", () => {
  it("survives a schema parse, so it reaches 04-ir.json", () => {
    // Zod strips unknown keys, so an un-declared marker would silently vanish on any re-parse and
    // the person would never see what the replay found.
    const parsed = Target.parse({ role: "textbox", name: "Email", css: "#d-email", groundedAt: "replay" });
    expect(parsed.groundedAt).toBe("replay");
  });

  it("is optional — every existing IR still parses", () => {
    expect(Target.parse({ role: "button", name: "Save" }).groundedAt).toBeUndefined();
    const whole = IR.safeParse(ir([{ id: "s1", action: "click", target: { role: "button", name: "Save" } }]));
    expect(whole.success).toBe(true);
  });

  it("accepts only the one value it means", () => {
    // A free-form string would invite it becoming a second, undocumented status field.
    expect(Target.safeParse({ role: "x", groundedAt: "discovery" }).success).toBe(false);
  });

  it("is provenance only — the generator does not branch on it", async () => {
    const { generateSpec } = await import("../src/stages/generator.js");
    const withMark = generateSpec(ir([
      { id: "s1", action: "click", target: { role: "button", name: "Save", css: "#s", groundedAt: "replay" } },
    ]), "artifacts");
    const without = generateSpec(ir([
      { id: "s1", action: "click", target: { role: "button", name: "Save", css: "#s" } },
    ]), "artifacts");
    expect(withMark).toBe(without);
  });
});
