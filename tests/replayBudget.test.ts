import { describe, it, expect, vi } from "vitest";

/**
 * TD-153: live-extend never replays the EXACT same steps twice in one compile.
 *
 * The real failure, traced 2026-10-18 on saucedemo: attempt 1 filled the checkout form and went
 * for "Finish" without clicking "Continue". Live-extend replayed those same steps four times (each
 * replay served the identical cached snapshot) and spent all of MAX_LIVE_EXTENSIONS. Attempt 2 had
 * the right steps but could not replay them, so the case stopped short of "Finish".
 *
 * Driven through the real toIR loop: the model (gemini.js) and the browser (liveExtend.js) are
 * mocked, so grounding, the retry loop and the extension budget are the real code.
 */
const HOST = "https://shop.example";
const home = { url: `${HOST}/`, title: "Home", elements: [{ role: "button", name: "Checkout", css: "#checkout" }] };
const stepOne = { url: `${HOST}/step-one`, title: "Info", elements: [
  { role: "textbox", name: "First Name", css: "#first" }, { role: "button", name: "Continue", css: "#continue" }] };
const stepTwo = { url: `${HOST}/step-two`, title: "Overview", elements: [{ role: "button", name: "Finish", css: "#finish" }] };

const meta = { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: HOST };
const nav = { id: "s1", action: "navigate", target: { url: "/" } };
const checkout = { id: "s2", action: "click", target: { role: "button", name: "Checkout" } };
const first = { id: "s3", action: "fill", target: { role: "textbox", name: "First Name" }, value: "Jane" };
const cont = { id: "s4", action: "click", target: { role: "button", name: "Continue" } };
const finish = (id: string) => ({ id, action: "click", target: { role: "button", name: "Finish" } });
const done = (id: string) => ({ id, action: "assert", target: { text: "Thank you" }, assertion: "visible" });

let call = 0;
vi.mock("../src/llm/gemini.js", () => ({
  gemini: vi.fn(async () => {
    call++;
    // Attempt 1 forgets "Continue"; every later attempt has the right steps.
    const steps = call === 1
      ? [nav, checkout, first, finish("s4"), done("s5")]
      : [nav, checkout, first, cont, finish("s5"), done("s6")];
    return { content: JSON.stringify({ meta, steps }), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }),
}));

const replays: string[] = [];
const has = (m: any, url: string) => m.pages.some((p: any) => p.url === url);
const reach = (prefix: any[]) => prefix.some((s) => s.target?.name === "Continue") ? stepTwo
  : prefix.some((s) => s.target?.name === "Checkout") ? stepOne : home;
vi.mock("../src/stages/liveExtend.js", () => ({
  // Like the real one: a page already in the model throws "already in the model".
  extendAppModel: vi.fn(async (m: any, prefix: any[]) => {
    replays.push(JSON.stringify(prefix.map((s) => s.id)));
    const page = reach(prefix);
    if (has(m, page.url)) throw new Error(`replay reached ${page.url}, which is already in the model`);
    return { ...m, pages: [...m.pages, page] };
  }),
  // A refresh follows an "already in the model" extend in the SAME loop pass, so it is not counted.
  refreshPageModel: vi.fn(async (m: any) => m),
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: true, corrected: false })),
  isPureTextAssertion: () => true,
  captureScreenAt: vi.fn(),
}));

const { toIR } = await import("../src/stages/ir.js");

const tc: any = { title: "checkout", priority: "high", feature: "Checkout", category: "valid",
  steps: ["click Checkout", "type a first name", "click Continue", "click Finish"], expected: "Thank you",
  fromPrompt: true, generatedFrom: "upfront", intent: "i", whyItMatters: "w" };

describe("TD-153 a wrong first attempt cannot spend the replay budget the right one needs", () => {
  it("saucedemo shape: the corrected attempt still replays its own steps and reaches Finish", async () => {
    call = 0; replays.length = 0;
    const model: any = { baseUrl: HOST, pages: [home] };
    const { ir } = await toIR(tc, model, `replay-budget-${Date.now()}-${Math.random()}`, `${HOST}/`);
    expect(ir.meta.truncated).not.toBe(true);
    expect(ir.steps.map((s) => s.target?.name)).toContain("Finish");
    // The steps attempt 1 ended on were replayed once, not once per remaining budget slot.
    const counts = new Map<string, number>();
    for (const r of replays) counts.set(r, (counts.get(r) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBe(1);
    // ...and the corrected attempt's steps (through Continue) were replayed.
    expect(replays).toContain(JSON.stringify(["s1", "s2", "s3", "s4"]));
  });
});
