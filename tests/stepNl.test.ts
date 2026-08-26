import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Step } from "../src/schema/ir.js";

/**
 * Free-text step translation — "write it however you like, we'll say it properly".
 *
 * The feature's whole safety argument is that a model NEVER widens what the system accepts. It
 * proposes sentences; those sentences are then run back through the SAME `parseIrStep` the save
 * path uses, here, before anything is shown to a person. So the tests that matter are not about
 * prompt quality — they are about what happens when the model misbehaves:
 *
 *   - returns a sentence the parser still cannot read      -> refused, nothing proposed
 *   - returns a different number of lines than it was given -> refused (positional base-matching
 *                                                              would silently re-point every
 *                                                              later step at the wrong original)
 *   - quietly "improves" a line nobody asked about          -> ignored, the draft wins
 *
 * The third is the quiet one, and the reason `steps` is rebuilt from the drafts rather than taken
 * from the model: a reworded untouched line parses fine, so no gate catches it, and it would cost
 * a browser walk the person never asked for.
 */

const geminiMock = vi.fn();
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { proposeStepTranslation, unreadableDraftIndexes, nlStepsEnabled } =
  await import("../src/server/rewrite.js");

const STEPS: Step[] = [
  { id: "s1", action: "navigate", target: { url: "/login" } },
  { id: "s2", action: "fill", target: { role: "textbox", name: "Email", css: "#email" }, value: "${env:TEST_USERNAME}" },
  { id: "s3", action: "click", target: { role: "button", name: "Sign in", css: "#go" } },
];

const IR: any = { meta: { title: "Sign in", baseUrl: "https://x.test" }, steps: STEPS };

/** The drafts as the editor would hold them: line 3 retyped in loose English. */
const DRAFTS = [
  "Go to /login",
  'Type "${env:TEST_USERNAME}" into textbox "Email"',
  "click the sign in button please",
];

function reply(body: unknown) {
  geminiMock.mockResolvedValueOnce({ content: JSON.stringify(body) });
}

beforeEach(() => {
  geminiMock.mockReset();
  delete process.env.NL_STEPS_ENABLED;
});

describe("nlStepsEnabled", () => {
  it("defaults off, like every other capability flag", () => {
    expect(nlStepsEnabled()).toBe(false);
    process.env.NL_STEPS_ENABLED = "yes";
    expect(nlStepsEnabled()).toBe(false); // only the exact string turns it on
    process.env.NL_STEPS_ENABLED = "true";
    expect(nlStepsEnabled()).toBe(true);
  });
});

describe("unreadableDraftIndexes", () => {
  it("finds only the lines the real parser rejects", () => {
    expect(unreadableDraftIndexes(DRAFTS, STEPS)).toEqual([2]);
  });

  it("treats an untouched, correctly-worded list as nothing to do", () => {
    expect(unreadableDraftIndexes(DRAFTS.slice(0, 2), STEPS)).toEqual([]);
  });
});

describe("proposeStepTranslation", () => {
  it("rewrites only the unreadable line and reports which one", async () => {
    reply({ steps: [DRAFTS[0], DRAFTS[1], 'Click on button "Sign in"'], note: "read it as the Sign in button" });
    const p = await proposeStepTranslation(IR, DRAFTS);

    expect(p.translatedIndexes).toEqual([2]);
    expect(p.steps[2]).toBe('Click on button "Sign in"');
    expect(p.before).toEqual(DRAFTS);
    // Untouched rows come back byte-identical, which is what keeps the save free for them.
    expect(p.steps.slice(0, 2)).toEqual(DRAFTS.slice(0, 2));
  });

  it("refuses when the suggestion is STILL unreadable, rather than proposing it", async () => {
    reply({ steps: [DRAFTS[0], DRAFTS[1], "just log in somehow"], note: "" });
    await expect(proposeStepTranslation(IR, DRAFTS)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("line 3"),
    });
  });

  it("refuses a line count that does not match — a silent insert would re-base every later step", async () => {
    reply({ steps: [DRAFTS[0], DRAFTS[1], "Wait briefly", 'Click on button "Sign in"'], note: "" });
    await expect(proposeStepTranslation(IR, DRAFTS)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("4 steps for 3 lines"),
    });
  });

  it("ignores the model rewording a line nobody asked about", async () => {
    reply({
      // Line 2 is valid and was NOT marked for rewrite; the model "improved" the role anyway.
      steps: [DRAFTS[0], 'Type "${env:TEST_USERNAME}" into textbox "Email address"', 'Click on button "Sign in"'],
      note: "",
    });
    const p = await proposeStepTranslation(IR, DRAFTS);
    expect(p.steps[1]).toBe(DRAFTS[1]);
    expect(p.translatedIndexes).toEqual([2]);
  });

  it("does not call the model at all when every line already parses", async () => {
    await expect(proposeStepTranslation(IR, DRAFTS.slice(0, 2))).rejects.toMatchObject({ status: 400 });
    expect(geminiMock).not.toHaveBeenCalled();
  });

  it("shows the model the credential placeholder rule, and preserves the placeholder", async () => {
    reply({ steps: [DRAFTS[0], DRAFTS[1], 'Click on button "Sign in"'], note: "" });
    const p = await proposeStepTranslation(IR, DRAFTS);
    expect(geminiMock.mock.calls[0][0]).toContain("${env:...}");
    expect(p.steps.join("\n")).toContain("${env:TEST_USERNAME}");
  });

  it("rejects an empty or oversized draft list before spending a call", async () => {
    await expect(proposeStepTranslation(IR, [])).rejects.toMatchObject({ status: 400 });
    await expect(proposeStepTranslation(IR, ["x".repeat(501)])).rejects.toMatchObject({ status: 400 });
    expect(geminiMock).not.toHaveBeenCalled();
  });
});
