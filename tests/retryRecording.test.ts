import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { LlmBudget } from "../src/llm/llmBudget.js";

/**
 * A run records WHY each attempt was rejected, into its own usage artifact.
 *
 * WHY THIS EXISTS. The retry count is the dominant cost in a run and nothing recorded the reason.
 * Measured on a real saucedemo run: **20 IR calls for 5 cases — exactly `MAX_IR_ATTEMPTS` (4) per
 * case — and zero cases passed.** Every case burned every attempt. Whether that is fixable waste
 * or the honest price of the project's central rule (every model claim gets a deterministic check)
 * depends entirely on the reasons, and those only ever existed in `console.log`.
 *
 * Logs cannot answer it on this deployment. Azure storage is ephemeral, so a run's artifacts are
 * gone by the next deploy — eleven container restarts inside two hours on 2026-09-25 — and Log
 * Analytics sampled the `[ir]` lines away when they were requested. Putting the record in
 * `08-llm-usage.json` makes every run answer the question by itself, with no log dependency and no
 * race against the next deploy.
 */

describe("LlmBudget.recordRetry", () => {
  it("carries the record through to the snapshot", () => {
    const b = new LlmBudget();
    b.recordRetry({ stage: "ir", caseTitle: "Sorting products", attempt: 2,
                    kind: "grounding", reason: "no element with role=combobox and name=Sort" });

    const snap = b.snapshot();
    expect(snap.retries).toHaveLength(1);
    expect(snap.retries[0]).toMatchObject({
      stage: "ir", caseTitle: "Sorting products", attempt: 2, kind: "grounding",
    });
    expect(snap.retries[0].reason).toContain("role=combobox");
  });

  it("is empty when nothing was rejected — itself a finding", () => {
    // A run whose tokens went somewhere other than retries should say so plainly, not leave the
    // reader to infer it from an absent field.
    expect(new LlmBudget().snapshot().retries).toEqual([]);
  });

  it("keeps per-case order, so a pattern across cases is visible", () => {
    const b = new LlmBudget();
    b.recordRetry({ stage: "ir", caseTitle: "A", attempt: 1, kind: "grounding", reason: "x" });
    b.recordRetry({ stage: "ir", caseTitle: "A", attempt: 2, kind: "grounding", reason: "x" });
    b.recordRetry({ stage: "ir", caseTitle: "B", attempt: 1, kind: "missing-actions", reason: "y" });

    const r = b.snapshot().retries;
    expect(r.map((x) => `${x.caseTitle}${x.attempt}`)).toEqual(["A1", "A2", "B1"]);
    // The question the artifact has to answer: is one KIND responsible for most of the spend?
    const byKind = r.reduce<Record<string, number>>((a, x) => ({ ...a, [x.kind]: (a[x.kind] ?? 0) + 1 }), {});
    expect(byKind).toEqual({ grounding: 2, "missing-actions": 1 });
  });

  it("truncates the reason — a grounding message can carry the page's own text", () => {
    const b = new LlmBudget();
    b.recordRetry({ stage: "ir", attempt: 1, kind: "grounding", reason: "z".repeat(5000) });
    expect(b.snapshot().retries[0].reason.length).toBe(300);
  });

  it("caps the list so a pathological run cannot bloat the artifact", () => {
    const b = new LlmBudget();
    for (let i = 0; i < 500; i++) {
      b.recordRetry({ stage: "ir", attempt: 1, kind: "grounding", reason: "r" });
    }
    expect(b.snapshot().retries).toHaveLength(200);
  });

  it("does not disturb the token counters", () => {
    // Bookkeeping must never look like spend. A retry record is not a call.
    const b = new LlmBudget();
    b.record("ir", { promptTokens: 100, completionTokens: 20 }, "azure");
    b.recordRetry({ stage: "ir", attempt: 1, kind: "grounding", reason: "r" });

    const snap = b.snapshot();
    expect(snap.calls).toBe(1);
    expect(snap.totalTokens).toBe(120);
    expect(snap.byStage.ir.calls).toBe(1);
  });

  it("snapshot returns a copy, so a later retry cannot mutate a saved artifact", () => {
    // 08-llm-usage.json is written more than once per run (happy path and catch); handing out the
    // live array would let a later rejection appear inside an already-saved snapshot.
    const b = new LlmBudget();
    b.recordRetry({ stage: "ir", attempt: 1, kind: "grounding", reason: "first" });
    const snap = b.snapshot();
    b.recordRetry({ stage: "ir", attempt: 2, kind: "grounding", reason: "second" });
    expect(snap.retries).toHaveLength(1);
  });
});

describe("ir.ts records every rejection it retries", () => {
  const SRC = readFileSync(new URL("../src/stages/ir.ts", import.meta.url), "utf8");
  const code = SRC.split("\n")
    .map((l) => { const i = l.indexOf("//"); return i < 0 ? l : l.slice(0, i); }).join("\n");

  it("routes rejections through the recording helper", () => {
    // Each of these is a distinct reason an attempt is sent back. A site that sets lastErr and
    // correction directly would spend an attempt invisibly — which is the state this replaced.
    for (const kind of ["schema", "vacuous-assertion", "url-mismatch",
                        "clicked-element-hidden", "cross-form-bleed", "missing-actions"]) {
      expect(code, `no reject("${kind}", …) site`).toContain(`reject("${kind}"`);
    }
    // Grounding passes its own structured kind through rather than flattening it.
    expect(code).toContain('reject(ungrounded.kind ?? "grounding"');
  });

  it("no rejection still sets correction by hand", () => {
    // The pairing `lastErr = x; correction = x;` is exactly what went unrecorded before.
    expect(code).not.toMatch(/lastErr = (\w+)\.message;\s*\n\s*correction = \1\.message;/);
  });
});
