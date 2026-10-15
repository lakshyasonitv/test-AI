import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * An ORDINARY (non-Salesforce) run's IR retry prompts are byte-identical to a capture taken from the
 * code before the screens-block cap (handoff Phase 1b). The screens block (TD-122) is Salesforce-only;
 * this pins that nothing about it — the cap, the MAX_CHARS loop that drops its oldest screens, the
 * log line, or the screen map that later feeds it (Phase 2) — can leak into anyone else's prompt.
 * Same discipline as fixtures/salesforceTarget/null-run-prompts.json, but for the USER prompt of a
 * retry, which is where the block lives.
 *
 * The mocked layer is gemini.js, so the real prompt assembly, correction text and grounding run.
 * The run's unique source prompt (it keeps the LLM cache out of the way) is replaced by <SOURCE>.
 *
 * To re-capture deliberately: WRITE_RETRY_PROMPT_FIXTURE=1 npx vitest run tests/retryPromptOrdinary.test.ts
 */
const FIXTURE = new URL("./fixtures/salesforceTarget/retry-prompt-ordinary.json", import.meta.url);

const prompts: string[] = [];
vi.mock("../src/llm/gemini.js", () => ({
  gemini: vi.fn(async (u: string) => {
    prompts.push(u);
    // Always the same IR, whose second step names a button the page does not have, so every
    // attempt is rejected by grounding and retried with the correction.
    const body = {
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://app.example" },
      steps: [
        { id: "s1", action: "navigate", target: { url: "/" } },
        { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
        { id: "s3", action: "click", target: { role: "button", name: "Budget Range" } },
      ],
    };
    return { content: JSON.stringify(body), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }),
}));
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: vi.fn(async (m: any) => m), refreshPageModel: vi.fn(async (m: any) => m),
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));

const { toIR } = await import("../src/stages/ir.js");
const { withTargetApp } = await import("../src/runTarget.js");

const HOST = "https://app.example";
const appModel: any = {
  baseUrl: HOST,
  pages: [{ url: `${HOST}/`, title: "Home", concepts: ["Signup"],
    elements: [{ role: "textbox", name: "Email" }, { role: "button", name: "Go" }] }],
};
const tc: any = { title: "t", priority: "high", feature: "Signup", category: "valid", steps: ["s"], expected: "e",
  fromPrompt: true, generatedFrom: "upfront", intent: "i", whyItMatters: "w" };

async function irPrompts(tag: string, run: (f: () => Promise<unknown>) => Promise<unknown>): Promise<string[]> {
  const source = `${tag}-${Date.now()}-${Math.random()}`;
  prompts.length = 0;
  await run(() => toIR(tc, appModel, source, `${HOST}/`));
  return prompts.filter((p) => /Return IR JSON/.test(p)).map((p) => p.split(source).join("<SOURCE>"));
}

describe("an ordinary run's IR retry prompts are byte-identical to before Phase 1b", () => {
  it("outside any run, and inside a run with no target app", async () => {
    const plain = await irPrompts("plain", (f) => f());
    expect(plain.length).toBeGreaterThanOrEqual(2); // a first attempt AND at least one retry
    expect(plain[1]).toMatch(/Your previous attempt was REJECTED/);

    if (process.env.WRITE_RETRY_PROMPT_FIXTURE === "1") writeFileSync(FIXTURE, JSON.stringify(plain, null, 1) + "\n");
    const baseline: string[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(plain).toEqual(baseline);

    const nullApp = await irPrompts("null-app", (f) => withTargetApp(null, f));
    expect(nullApp).toEqual(baseline);
  });

  it("the same retry on a Salesforce run differs only by its own additions (the gate is what differs)", async () => {
    const sf = await irPrompts("sf", (f) => withTargetApp("salesforce", f));
    expect(sf.length).toBeGreaterThanOrEqual(2);
    expect(sf[1]).toMatch(/Your previous attempt was REJECTED/);
  });
});
