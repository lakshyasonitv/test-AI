import { describe, it, expect, vi } from "vitest";
import { hiddenInputNames, isUsableElement, isHiddenInput, toLiteModel, toMicroModel } from "../src/schema/appModel.js";

/**
 * TD-62 on the IR path.
 *
 * `withFilteredElements` used to keep anything named with an interactive role. That let hidden
 * form inputs and keyboard skip-links through as ordinary controls, and `toMicroModel` then caps
 * at 30 — so they competed for slots against elements a test could actually use.
 *
 * Measured on the saved amazon run before the fix: **11 of the 30 elements the model saw** were
 * un-actionable — two `add-new` inputs, a live CSRF token, `IP2LOCATION`, a hidden `Search in`
 * combobox and six keyboard skip-links — while eleven real category links never reached the
 * prompt at all. Playwright would have refused to act on any of the eleven, since its
 * actionability checks require visibility, so a case written against one could never have passed.
 *
 * The predicate lives in `appModel.ts` next to `INTERACTIVE_ROLES` precisely so this filter and
 * the test-case projection cannot drift apart again — a second copy is how they diverged.
 */

const CSRF = "hEj/Wh8642+o8zAEP15lt9A5gFAdyyTAqoNqg9Fa9jHD";

/** The two shapes seen in real data, which is why one signal is not enough. */
const page: any = {
  url: "https://x.test/",
  title: "T",
  concepts: [],
  elements: [
    { role: "searchbox", name: "Search the site", visible: true },
    { role: "link", name: "Electronics", visible: true },
    { role: "button", name: "Go", visible: true },
    // (a) marked not visible — skip-links and session inputs on the amazon homepage
    { role: "link", name: "nav top", visible: false },
    { role: "textbox", name: "IP2LOCATION", visible: false },
    { role: "textbox", name: CSRF, visible: false },
    // (b) recorded visible:true, and only the forms block reveals them — the sign-in pages
    { role: "textbox", name: "SIGNIN_CLAIM_COLLECT", visible: true },
    { role: "textbox", name: "claimType", visible: true },
    // Not interactive at all — excluded for the original reason, still.
    { role: "paragraph", name: "Welcome back", visible: true },
    { role: "link", name: "", visible: true },
  ],
  forms: [{ fields: [
    { inputType: "hidden", name: "appAction", value: "SIGNIN_CLAIM_COLLECT" },
    { inputType: "hidden", name: "claimType", value: "" },
    { inputType: "hidden", name: "anti-csrftoken-a2z", value: CSRF },
    { inputType: "text", name: "field-keywords", label: "Search the site" },
  ] }],
};

const kept = () => {
  const hidden = hiddenInputNames(page);
  return page.elements.filter((e: any) => isUsableElement(e, hidden)).map((e: any) => e.name);
};

describe("TD-62 — the IR element filter excludes what no test can act on", () => {
  it("keeps every real control", () => {
    expect(kept()).toEqual(["Search the site", "Electronics", "Go"]);
  });

  it("drops elements marked not visible, including a CSRF token", () => {
    const names = kept();
    for (const n of ["nav top", "IP2LOCATION", CSRF]) expect(names).not.toContain(n);
  });

  it("drops hidden inputs that are recorded visible:true — forms[] is the only witness", () => {
    // This is the half `visible` alone cannot see. On the real run, SIGNIN_CLAIM_COLLECT,
    // claimType and countryCode are all visible:true.
    const names = kept();
    expect(names).not.toContain("SIGNIN_CLAIM_COLLECT");
    expect(names).not.toContain("claimType");
  });

  it("still drops unnamed and non-interactive elements, the original rule", () => {
    expect(kept()).not.toContain("Welcome back");
    expect(kept()).not.toContain("");
  });

  it("matches a hidden field by its VALUE, because that becomes the accessible name", () => {
    const hidden = hiddenInputNames(page);
    // `appAction`'s value is what the element is "named" after; the name itself never appears.
    expect(hidden.has("SIGNIN_CLAIM_COLLECT")).toBe(true);
    expect(hidden.has(CSRF)).toBe(true);
    expect(isHiddenInput({ role: "textbox", name: CSRF } as any, hidden)).toBe(true);
  });

  it("leaves a page with no forms block alone rather than throwing", () => {
    const bare = { url: "u", title: "t", concepts: [], elements: [] } as any;
    expect(hiddenInputNames(bare).size).toBe(0);
  });
});

describe("TD-62 — the fix reaches the real IR prompt", () => {
  it("keeps hidden inputs out of the model block toIR sends", async () => {
    const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
    vi.doMock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));
    geminiMock.mockResolvedValue({
      content: JSON.stringify({
        meta: { feature: "F", title: "T", priority: "high", sourcePrompt: "p", baseUrl: "https://x.test" },
        steps: [{ id: "s1", action: "navigate", target: { url: "/" } }],
      }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    const { toIR } = await import("../src/stages/ir.js");
    const model: any = { baseUrl: "https://x.test", pages: [page] };
    const testCase: any = {
      title: "T", priority: "high", feature: "F", category: "valid",
      steps: ["Click Go"], expected: "ok", targetUrl: "https://x.test/",
    };
    // Unique prompt: toIR disk-caches, and a hit would skip gemini and make this vacuous.
    await toIR(testCase, model, `td62 ${Date.now()}-${Math.random()}`, "https://x.test/")
      .catch(() => undefined);
    expect(geminiMock).toHaveBeenCalled();
    const prompt = String(geminiMock.mock.calls[0][0]);

    // What the ELEMENT filter is responsible for, and now removes.
    expect(prompt).not.toContain("IP2LOCATION");
    expect(prompt).not.toContain("nav top");
    expect(prompt).toContain("Electronics");        // a real control still reaches the model

    // NOT asserted, deliberately: `SIGNIN_CLAIM_COLLECT` and the CSRF token still appear in this
    // prompt — not as elements, but inside the `forms` block, which toMicroModel emits verbatim
    // (`fields.slice(0, 20)`) with every hidden field's name AND value. That is a SECOND defect
    // on a different code path, filed as TD-63; measured at 1 run leaking into the IR prompt and
    // 2 into the test-case prompt across the 38-run corpus.
    //
    // Asserting it here would either fail for a reason this fix is not responsible for, or —
    // worse — tempt someone to widen `withFilteredElements` to paper over a forms-block problem
    // it cannot see. The gap is recorded rather than blurred.
    // TD-63 has landed, so this is no longer inverted: the forms block is filtered too, and the
    // hidden field's name and its value are both gone from the prompt entirely.
    expect(prompt).not.toContain("SIGNIN_CLAIM_COLLECT");
    expect(prompt).not.toContain(CSRF);
  });
});

describe("TD-63 — the forms block never carries a hidden field's value out", () => {
  /**
   * A separate channel from the element filter. `toLiteModel` and `toMicroModel` both project
   * `forms`, and both used `fields.slice(0, cap)` on the raw list — so a hidden field excluded
   * from `elements` reappeared in `forms`, complete with its value.
   *
   * Measured on the saved corpus before the fix: 1 run leaked into the IR prompt, 2 into the
   * test-case prompt, including `anti-csrftoken-a2z` and its live token. On the amazon run, 48 of
   * 54 hidden fields carried a non-empty value.
   *
   * `scrubServedSecrets` could never have caught this: it redacts KNOWN secret values (the
   * operator's TEST_USERNAME / TEST_PASSWORD), and a CSRF token is supplied by the site under
   * test, so it is on no list to redact against. The only place to stop it is where it is
   * projected.
   */
  const CSRF2 = "hEj/Wh8642+o8zAEP15lt9A5gFAdyyTAqoNqg9Fa9jHD";
  const model: any = {
    baseUrl: "https://x.test",
    pages: [{
      url: "https://x.test/", title: "T", concepts: [],
      elements: [{ role: "searchbox", name: "Search the site", visible: true }],
      forms: [{
        action: "/go", method: "POST", id: "f1", name: "",
        fields: [
          { tag: "input", inputType: "hidden", name: "anti-csrftoken-a2z", value: CSRF2, label: "" },
          { tag: "input", inputType: "hidden", name: "appAction", value: "SIGNIN_CLAIM_COLLECT", label: "" },
          { tag: "input", inputType: "text", name: "field-keywords", label: "Search the site", value: "" },
          { tag: "input", inputType: "password", name: "password", label: "Password", value: "" },
        ],
      }],
    }],
  };

  for (const [label, project] of [
    ["toLiteModel (test-case prompt)", (m: any) => JSON.stringify(toLiteModel(m))],
    ["toMicroModel (IR prompt)", (m: any) => JSON.stringify(toMicroModel(m, { currentPageUrl: "https://x.test/" }))],
  ] as [string, (m: any) => string][]) {
    it(`${label} carries neither the hidden field nor its value`, () => {
      const out = project(model);
      expect(out).not.toContain(CSRF2);
      expect(out).not.toContain("anti-csrftoken");
      expect(out).not.toContain("SIGNIN_CLAIM_COLLECT");
      // ...while the fields a test CAN act on survive, so this is a filter and not a blanket drop.
      expect(out).toContain("field-keywords");
      expect(out).toContain("Password");
    });
  }

  it("filters BEFORE the cap, so hidden fields cannot consume the field budget", () => {
    // 30 hidden fields ahead of one real one: slicing first would emit 20 hidden and lose the real
    // field entirely, which is the ordering bug this fixes.
    const m: any = JSON.parse(JSON.stringify(model));
    m.pages[0].forms[0].fields = [
      ...Array.from({ length: 30 }, (_, i) => ({ tag: "input", inputType: "hidden", name: `h${i}`, value: `v${i}`, label: "" })),
      { tag: "input", inputType: "text", name: "field-keywords", label: "Search the site", value: "" },
    ];
    const out = JSON.stringify(toLiteModel(m));
    expect(out).toContain("field-keywords");
    expect(out).not.toContain("\"h0\"");
  });
});
