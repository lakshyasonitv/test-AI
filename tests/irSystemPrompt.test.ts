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
  // Asserts the RULE is present, not one phrasing of it. The wording was generalised (it used
  // to name "menu-toggle"/"hamburger" and "responsive CSS breakpoint" literally, which pinned
  // the prompt to one site's vocabulary); what has to survive is that the model is steered off
  // an open/collapse control and told the reason is viewport-dependent visibility.
  it("tells the model to avoid a menu-toggle control as the sole representative of a nav check", async () => {
    groqMock.mockClear();
    await toIR(testCase, appModel, `check the header ${Date.now()}-${Math.random()}`, `${HOST}/`);
    const [, opts] = groqMock.mock.calls[0];
    expect(opts.system).toMatch(/OPEN or COLLAPSE|open\/collapse|menu-toggle/i);
    expect(opts.system).toMatch(/viewport width|responsive CSS breakpoint/i);
  });
});

// Regression: a plain 3-step login case's IR came back referencing an unrelated product page —
// buildUser sends both the specific testCase AND the full original sourcePrompt in the same
// message, with nothing telling the model the latter is background context only, not a second
// source of steps. Confirmed against a real run this session (case-2 of a saucedemo suite,
// title drifted to "...and add product to cart" despite its own testCase never mentioning one).
describe("toIR system prompt — sourcePrompt scope-bleed guard", () => {
  it("tells the model to build the IR from testCase alone, not the broader sourcePrompt", async () => {
    groqMock.mockClear();
    await toIR(testCase, appModel, `check just the login, nothing else ${Date.now()}-${Math.random()}`, `${HOST}/`);
    const [, opts] = groqMock.mock.calls[0];
    expect(opts.system).toContain("BUT ONLY THE CASE");
    expect(opts.system).toContain("not a second source of steps");
  });
});
