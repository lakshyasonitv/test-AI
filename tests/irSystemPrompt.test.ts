import { describe, it, expect, vi } from "vitest";

// Regression: the model picked the AppModel's per-page "title" field (the browser tab /
// <title> tag, never rendered in the page body) as a visible-text assertion target — an
// assertion that can never pass on any real page. Confirmed against a real run
// (2026-08-06T18-48-15-013Z-4363e3d0, case-0): getByText("Thinkvibes – from vision to
// reality") failed because that text only ever existed in the page's <title>, not its body.
// Fix is a system-prompt rule; this just verifies the rule is actually sent to the model.

const HOST = "https://ir-title-check.example";
const GROUNDED_IR = {
  meta: { feature: "Nav", title: "Homepage loads", priority: "high", sourcePrompt: "p", baseUrl: HOST },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "assert", target: { role: "heading", name: "Welcome" }, assertion: "visible" },
  ],
};

const { groqMock } = vi.hoisted(() => ({
  groqMock: vi.fn(async () => ({
    content: JSON.stringify(GROUNDED_IR),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  })),
}));
vi.mock("../src/llm/groq.js", () => ({ groq: groqMock }));

const { toIR } = await import("../src/stages/ir.js");

const appModel: any = {
  baseUrl: HOST,
  pages: [{
    url: `${HOST}/`,
    title: "Example – tagline text",
    concepts: ["Navigation"],
    elements: [{ role: "heading", name: "Welcome" }],
  }],
};
const testCase: any = {
  title: "Homepage loads", priority: "high", feature: "Nav",
  steps: ["Navigate to /", "Assert 'Welcome' is visible"], expected: "Welcome heading is visible",
  category: "valid", generatedFrom: "upfront",
};

describe("toIR system prompt — page title guard", () => {
  it("tells the model the page title field is never assertable as visible text", async () => {
    groqMock.mockClear();
    // toIR disk-caches by a hash of (testCase, sourcePrompt, appModel, creds) — a static
    // fixture would hit a previous run's cache entry and never call groq() again, silently
    // making this assertion vacuous. A unique sourcePrompt per invocation forces a cache miss.
    await toIR(testCase, appModel, `check the homepage ${Date.now()}-${Math.random()}`, `${HOST}/`);
    const [, opts] = groqMock.mock.calls[0];
    expect(opts.system).toContain("never rendered in the page body");
    expect(opts.system).toContain("<title>");
  });
});

// Regression: a case describing a header/nav block by listing several items ("Menu Who We
// Are Services...") ground on #nav-toggle — the mobile hamburger icon, hidden by a CSS media
// query at desktop width that discovery (cheerio, no real CSS engine) can't detect. Confirmed
// against a real run (2026-08-06T19-23-32-512Z-e3943abb, case-0): the toggle was recorded
// visible:true by discovery but reported hidden by the actual browser at test time.
describe("toIR system prompt — mobile-toggle grounding guard", () => {
  it("tells the model to avoid a menu-toggle control as the sole representative of a header/nav check", async () => {
    groqMock.mockClear();
    await toIR(testCase, appModel, `check the header ${Date.now()}-${Math.random()}`, `${HOST}/`);
    const [, opts] = groqMock.mock.calls[0];
    expect(opts.system).toContain("menu-toggle");
    expect(opts.system).toContain("responsive CSS breakpoint");
  });
});
