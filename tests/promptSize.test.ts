import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { capAriaSnapshot, INTERACTIVE_SECTION_MARKER } from "../src/stages/discovery.js";
import { capElementsList } from "../src/stages/hybridDiscovery.js";
import type { Element } from "../src/schema/appModel.js";

/**
 * Bounds on what may become a prompt — TECH_DEBT.md TD-73.
 *
 * THE MEASUREMENT. Run `2026-09-03T11-49-04-132Z-f568ba48` (amazon.in) recorded
 * `discovery: 1 call, 514,427 prompt tokens` — more than every other run in `runs/` combined, and
 * 40% of all prompt tokens on disk.
 *
 * The cause was NOT the uncapped ARIA snapshot it first looked like: every page in that run has
 * `discoveryMethod: "dom"`, so the vision path never ran. It was `labelConceptsWithDOM`'s element
 * list, which is built one line per element with the element's accessible NAME inlined — and on
 * that homepage a `main` element's name was an inlined stylesheet **648,107 characters** long,
 * beginning `.gwm-window-tile:nth-child(9n+1) {background-…`. Median name length on the same
 * page: 15. Four elements were 99% of the payload.
 *
 * So the bound that matters is per-NAME, not per-element-count, and these tests assert both.
 */

describe("capElementsList — the concept-labeling prompt", () => {
  const el = (over: Partial<Element>): Element =>
    ({ role: "button", name: "Go", visible: true, ...over }) as Element;

  it("caps a single runaway name without dropping the element", () => {
    const list = capElementsList([
      el({ role: "main", name: ".gwm-window-tile{background:red}".repeat(20_000) }),
      el({ role: "button", name: "Add to cart" }),
    ]);
    expect(list.length).toBeLessThan(2_000);
    // The element is still THERE — it is only its runaway name that is cut. Dropping the row
    // would renumber nothing (indices are explicit) but would hide a real element from labeling.
    expect(list).toContain("[0] main");
    expect(list).toContain("chars omitted]");
    expect(list).toContain(`[1] button "Add to cart"`);
  });

  it("keeps ORIGINAL indices, because the caller maps answers back by index", () => {
    // labelConceptsWithDOM's callers do `labeledElements.find(l => l.index === i)` against the
    // UNFILTERED page.elements. Renumbering here would label the wrong elements.
    const list = capElementsList([
      el({ name: "a" }), el({ name: "b" }), el({ name: "c" }),
    ]);
    expect(list.split("\n").map((l) => l.slice(0, 3))).toEqual(["[0]", "[1]", "[2]"]);
  });

  it("caps the whole list when a page has thousands of ordinary elements", () => {
    const many = Array.from({ length: 5000 }, (_, i) => el({ name: `Item number ${i}` }));
    const list = capElementsList(many);
    expect(list.length).toBeLessThanOrEqual(40_000);
    // Drops from the END, like every other prompt-fitting helper here, so a page's chrome and
    // primary navigation — which it declares first — survive.
    expect(list).toContain("Item number 0");
    expect(list).not.toContain("Item number 4999");
  });

  it("leaves an ordinary page completely untouched", () => {
    const small = [el({ name: "Sign in" }), el({ role: "textbox", name: "Email" })];
    expect(capElementsList(small)).toBe(
      `[0] button "Sign in" (visible: true, section: body)\n` +
      `[1] textbox "Email" (visible: true, section: body)`,
    );
  });

  /**
   * The regression, replayed against the real artifact rather than a synthetic stand-in. Skips
   * itself if that run has been pruned from `runs/` — the corpus is gitignored.
   */
  it("cuts the real amazon.in run's element list by >90%", () => {
    const f = "runs/2026-09-03T11-49-04-132Z-f568ba48/02-appmodel.json";
    if (!existsSync(f)) return;
    const model = JSON.parse(readFileSync(f, "utf8"));
    const home = model.pages[0];

    const before = home.elements
      .map((e: any, i: number) =>
        `[${i}] ${e.role} "${e.name}" (visible: ${e.visible ?? true}, section: ${e.pageSection ?? "body"})`)
      .join("\n");
    const after = capElementsList(home.elements);

    expect(before.length).toBeGreaterThan(700_000);          // 797,356 as measured
    expect(after.length).toBeLessThan(before.length * 0.1);  // ~17,075
    // Every element survives — this page needed only the per-name cap, not the list cap.
    // Exactly one line per element, every line starting with its index. Names are
    // whitespace-collapsed first: a name containing a newline used to split one element across
    // several lines, so every index after it described the tail of the previous name. This page
    // produced 273 lines from 229 elements before that collapse.
    expect(after.split("\n").length).toBe(home.elements.length);
    expect(after.split("\n").every((l) => /^\[\d+\] /.test(l))).toBe(true);
  });
});

describe("capAriaSnapshot — the vision-fallback prompt", () => {
  const interactiveTail = `${INTERACTIVE_SECTION_MARKER}\n- button "Checkout"\n- link "Cart"`;

  it("leaves a small snapshot alone", () => {
    const s = `- banner:\n  - link "Home"${interactiveTail}`;
    expect(capAriaSnapshot(s, 40_000)).toBe(s);
  });

  it("never cuts the interactive-elements section — it is appended last and matters most", () => {
    // A naive end-truncation deletes exactly this: the JS-detected controls the a11y tree
    // missed, which is the only reason the section exists.
    const huge = Array.from({ length: 60_000 }, (_, i) => `  - text: filler line ${i}`).join("\n");
    const out = capAriaSnapshot(huge + interactiveTail, 5_000);
    expect(out).toContain(`- button "Checkout"`);
    expect(out).toContain(`- link "Cart"`);
    expect(out.length).toBeLessThanOrEqual(5_000 + interactiveTail.length);
  });

  it("drops non-interactive nodes before interactive ones", () => {
    const noise = Array.from({ length: 4_000 }, (_, i) => `  - text: padding ${i}`).join("\n");
    const out = capAriaSnapshot(
      `- button "Keep me"\n${noise}\n- link "Keep me too"${interactiveTail}`, 3_000);
    expect(out).toContain(`- button "Keep me"`);
    expect(out).toContain(`- link "Keep me too"`);
    expect(out).not.toContain("padding 3999");
  });

  it("handles a 2 MB snapshot and still keeps the interactive elements", () => {
    // The scenario the cap exists for: a large, JS-heavy page hitting the vision fallback.
    const twoMb = Array.from({ length: 40_000 }, (_, i) =>
      `  - text: ${"lorem ipsum dolor sit amet ".repeat(2)}${i}`).join("\n");
    expect(twoMb.length).toBeGreaterThan(2_000_000);

    const out = capAriaSnapshot(
      `- button "Sign in"\n- textbox "Email"\n${twoMb}${interactiveTail}`, 40_000);

    expect(out.length).toBeLessThan(45_000);
    expect(out).toContain(`- button "Sign in"`);
    expect(out).toContain(`- textbox "Email"`);
    expect(out).toContain(`- button "Checkout"`);
  });

  it("copes with no interactive section at all", () => {
    const huge = Array.from({ length: 10_000 }, (_, i) => `  - text: x${i}`).join("\n");
    const out = capAriaSnapshot(huge, 2_000);
    expect(out.length).toBeLessThanOrEqual(2_000);
  });
});

describe("gemini — the hard prompt ceiling", () => {
  const ORIGINAL = process.env.LLM_MAX_PROMPT_CHARS;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.LLM_MAX_PROMPT_CHARS;
    else process.env.LLM_MAX_PROMPT_CHARS = ORIGINAL;
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("refuses an oversized prompt BEFORE sending anything", async () => {
    process.env.LLM_MAX_PROMPT_CHARS = "1000";
    process.env.GEMINI_API_KEYS = "test-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { gemini, PromptTooLargeError } = await import("../src/llm/gemini.js");
    await expect(gemini("x".repeat(2000), { stage: "discovery" }))
      .rejects.toBeInstanceOf(PromptTooLargeError);

    // The whole point: nothing was spent. A refusal that still made the call would be useless.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says which stage, how big, and that it is a bug in the prompt — not the site", async () => {
    process.env.LLM_MAX_PROMPT_CHARS = "500";
    process.env.GEMINI_API_KEYS = "test-key";
    vi.stubGlobal("fetch", vi.fn());
    const { gemini } = await import("../src/llm/gemini.js");

    const err = await gemini("y".repeat(900), { stage: "discovery" }).catch((e) => e);
    expect(err.stage).toBe("discovery");
    expect(err.chars).toBe(900);
    expect(err.limit).toBe(500);
    expect(err.isPromptTooLarge).toBe(true);
    // A person reading this must not go and look at their website.
    expect(String(err.message)).toMatch(/not something wrong with the site/i);
  });

  it("lets an ordinary prompt straight through", async () => {
    delete process.env.LLM_MAX_PROMPT_CHARS;
    process.env.GEMINI_API_KEYS = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "{}" }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
      }),
    })));
    const { gemini } = await import("../src/llm/gemini.js");
    const res = await gemini("a normal prompt", { stage: "plan" });
    expect(res.content).toBe("{}");
    expect(res.usage.promptTokens).toBe(10);
  });

  it("would have caught the amazon call — 514k tokens is far past the default ceiling", async () => {
    delete process.env.LLM_MAX_PROMPT_CHARS;   // default 200,000 chars
    process.env.GEMINI_API_KEYS = "test-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { gemini } = await import("../src/llm/gemini.js");

    // 797,356 chars was the real elementsList for that page.
    await expect(gemini("z".repeat(797_356), { stage: "discovery" })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
