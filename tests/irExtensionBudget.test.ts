import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: toIR's retry loop spent one of only MAX_IR_ATTEMPTS attempts on EVERY live-extend
// hop, identically to a fresh LLM generation — a flow needing several hops to fully discover
// (e.g. product page -> add to cart -> cart page) could burn its whole attempt budget just
// reaching the right page state, leaving none to actually use the now-correct model, and shipped
// a stale truncation note ("not present in the application model") that was already false by the
// time it was returned. Fix: live-extend hops re-ground the SAME already-parsed IR without
// spending a fresh attempt. This test proves it by setting MAX_IR_ATTEMPTS to 1 — the tightest
// possible budget — for a case needing TWO sequential extension hops to fully ground.

const HOST = "https://ir-extension-budget.example";

// Fixed IR: s3 targets an element only reachable after extending once; s4 targets an element
// only reachable after extending a SECOND time from there. Two hops, one parsed IR, one gemini call.
const MULTI_HOP_IR = {
  meta: { feature: "Shopping", title: "Add item and view cart", priority: "high", sourcePrompt: "p", baseUrl: HOST },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "click", target: { role: "link", name: "Product" } },
    { id: "s3", action: "click", target: { role: "button", name: "Add to cart" } },
    { id: "s4", action: "assert", target: { role: "heading", name: "Your Cart" }, assertion: "visible" },
  ],
};

vi.mock("../src/llm/gemini.js", () => ({
  gemini: vi.fn(async () => ({
    content: JSON.stringify(MULTI_HOP_IR),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  })),
}));

const { extendAppModelMock } = vi.hoisted(() => ({ extendAppModelMock: vi.fn() }));
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: extendAppModelMock,
  refreshPageModel: vi.fn(async (model: any) => model),
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));

const { toIR } = await import("../src/stages/ir.js");

// One page throughout (SPA-style: clicks reveal more content at the same URL) — sidesteps
// trackPages' link-href page-attribution entirely (it needs a domLinks entry to follow a link
// click to a different page, which this fixture deliberately doesn't model), so grounding
// simply checks each step's target against this one page's growing element list.
const baseAppModel: any = {
  baseUrl: HOST,
  pages: [{
    url: `${HOST}/`,
    title: "Home",
    concepts: ["Shopping"],
    elements: [{ role: "link", name: "Product" }],
  }],
};
const withAddToCart: any = {
  baseUrl: HOST,
  pages: [{
    ...baseAppModel.pages[0],
    elements: [...baseAppModel.pages[0].elements, { role: "button", name: "Add to cart" }],
  }],
};
const withCartHeading: any = {
  baseUrl: HOST,
  pages: [{
    ...withAddToCart.pages[0],
    elements: [...withAddToCart.pages[0].elements, { role: "heading", name: "Your Cart" }],
  }],
};

const testCase: any = {
  title: "Add item and view cart", priority: "high", feature: "Shopping", category: "state-change",
  steps: ["Click 'Product'", "Click 'Add to cart'", "Assert the cart is shown"],
  expected: "The cart page shows the added item", fromPrompt: true, generatedFrom: "upfront",
};

describe("toIR — live-extend hops don't consume the attempt budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // First extend call reveals "Add to cart"; second reveals "Your Cart" heading — two hops
    // needed to fully ground MULTI_HOP_IR, simulated as two progressively richer models.
    extendAppModelMock
      .mockResolvedValueOnce(withAddToCart)
      .mockResolvedValueOnce(withCartHeading);
  });

  it("fully grounds a 2-hop case even with only 1 LLM attempt allowed", async () => {
    const prevMax = process.env.MAX_IR_ATTEMPTS;
    process.env.MAX_IR_ATTEMPTS = "1";
    try {
      const { ir } = await toIR(testCase, baseAppModel, `prompt-${Date.now()}`, `${HOST}/`);
      expect(ir.meta.truncated).toBeFalsy();
      expect(ir.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
      expect(extendAppModelMock).toHaveBeenCalledTimes(2);
    } finally {
      if (prevMax === undefined) delete process.env.MAX_IR_ATTEMPTS;
      else process.env.MAX_IR_ATTEMPTS = prevMax;
    }
  });
});
