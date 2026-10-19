import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// TD-158, the Phase 1 follow-up: the post-click reveal check found "revealed" fields by NEW NAMES only.
// When discovery already holds a modal's fields (hidden, because the modal was closed), clicking its
// opener reveals nothing NEW by name, so a fill bound to an unrelated HIDDEN field (Demoblaze: the
// Sign-up modal's "Username:" instead of the order form's "Total: Name:") was accepted. Live: 5 of 5
// Demoblaze runs went this way exactly when the replayed cart was empty and the field kept its old
// name. With NETWORK_SETTLE_ENABLED the check also counts a field that was HIDDEN before the click and
// VISIBLE after it (same css) as revealed, and rejects a target that is STILL hidden after the click.

const HOST = "https://shop.example";
const el = (role: string, name: string, css: string, visible: boolean) => ({ role, name, css, visible });

// Discovery's cart page: both modals' fields are in the DOM, hidden.
const BEFORE = [
  el("link", "Cart", "#cartur", true),
  el("button", "Place Order", "button.btn-success", true),
  el("textbox", "Total: Name:", "#name", false),
  el("textbox", "Country:", "#country", false),
  el("textbox", "Username:", "#sign-username", false),
];
// After "Place Order": the order form is open; the Sign-up modal is still closed.
const AFTER = BEFORE.map((e) => (["#name", "#country"].includes(e.css) ? { ...e, visible: true } : e));
const page = (elements: any[]) => ({ url: `${HOST}/cart.html`, title: "Cart", concepts: ["Cart"], elements });
const appModel: any = { baseUrl: HOST, pages: [page(BEFORE)] };
const refreshed: any = { baseUrl: HOST, pages: [page(AFTER)] };

const irFilling = (name: string) => ({
  meta: { feature: "Checkout", title: "Place an order", priority: "high", sourcePrompt: "p", baseUrl: HOST },
  steps: [
    { id: "s1", action: "click", target: { role: "link", name: "Cart" } },
    { id: "s2", action: "click", target: { role: "button", name: "Place Order" } },
    { id: "s3", action: "fill", target: { role: "textbox", name }, value: "Test Buyer" },
    { id: "s4", action: "assert", target: { role: "button", name: "Place Order" }, assertion: "visible" },
  ],
});

const { geminiMock, refreshMock, extendMock } = vi.hoisted(() => ({
  geminiMock: vi.fn(), refreshMock: vi.fn(), extendMock: vi.fn(),
}));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: extendMock,
  refreshPageModel: refreshMock,
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));
const { toIR } = await import("../src/stages/ir.js");

const testCase: any = {
  title: "Place an order", priority: "high", feature: "Checkout",
  steps: ["Open the cart", "Click 'Place Order'", "Fill the order form", "Verify"],
  expected: "The order form is filled", category: "valid", generatedFrom: "upfront",
};
const uniquePrompt = () => `place an order ${Date.now()}-${Math.random()}`; // never an IR cache hit
const reply = (ir: any) => ({ content: JSON.stringify(ir), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });

beforeEach(() => {
  geminiMock.mockReset(); refreshMock.mockReset(); extendMock.mockReset();
  extendMock.mockImplementation(async (m: any) => m);
  refreshMock.mockResolvedValue(refreshed);
});
afterEach(() => { delete process.env.NETWORK_SETTLE_ENABLED; });

describe("TD-158: the reveal check sees fields that became VISIBLE, not only new names", () => {
  it("flag OFF (today): the hidden Sign-up field is accepted, because no NEW name appeared", async () => {
    geminiMock.mockResolvedValue(reply(irFilling("Username:")));
    const { ir } = await toIR(testCase, appModel, uniquePrompt(), `${HOST}/cart.html`);
    expect(geminiMock).toHaveBeenCalledTimes(1);
    expect(ir.steps[2].target!.css).toBe("#sign-username");
  });

  it("flag ON: a target still hidden after the click is rejected, naming the fields the click made visible", async () => {
    process.env.NETWORK_SETTLE_ENABLED = "true";
    geminiMock
      .mockResolvedValueOnce(reply(irFilling("Username:")))
      .mockResolvedValueOnce(reply(irFilling("Total: Name:")));
    const { ir } = await toIR(testCase, appModel, uniquePrompt(), `${HOST}/cart.html`);
    expect(geminiMock).toHaveBeenCalledTimes(2);
    const retry = geminiMock.mock.calls[1][0] as string;
    expect(retry).toContain("Total: Name:");
    expect(retry).toContain("still hidden");
    expect(ir.steps[2].target!.css).toBe("#name");
  });

  it("flag ON: a target that the click itself made visible is accepted in one attempt", async () => {
    process.env.NETWORK_SETTLE_ENABLED = "true";
    geminiMock.mockResolvedValue(reply(irFilling("Total: Name:")));
    const { ir } = await toIR(testCase, appModel, uniquePrompt(), `${HOST}/cart.html`);
    expect(geminiMock).toHaveBeenCalledTimes(1);
    expect(ir.steps[2].target!.css).toBe("#name");
  });
});
