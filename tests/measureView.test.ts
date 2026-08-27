import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { coverage, irReferences, elKey, checkMicroBaseline, buildView, hoistShared } from "../scripts/measureView.js";

/**
 * Self-test for the measurement harness.
 *
 * `scripts/measureView.ts` is load-bearing: every decision in the Site Store / View work is made
 * from its output. It shipped FOUR bugs in a row, and not one of them threw — each produced a
 * confident, wrong table:
 *
 *   1. `04-ir.json` is `{ir, updatedAppModel}`, not a bare IR. Reading `.steps` off the wrapper
 *      gave zero references, and coverage() returned 1 for zero references. "irCoverage 100% on
 *      38/38" measured nothing. Same shape as TD-01: a check that passes because it never looked.
 *   2. Keys were joined on \u0000 in some functions and on a space in others. A NUL key never
 *      equals a space key, so every comparison returned "missing" — 29/29 runs "truncating",
 *      0/0 runs "covered". Both artefacts.
 *   3. Live-extended elements were scored as truncations, blaming toMicroModel for elements that
 *      did not exist when it ran.
 *   4. Coverage counted `elements[]` only, while the prompt also carries a `navigation` tree and
 *      a `forms` block. Three nav links were reported as dropped by the element cap while the nav
 *      tree listed all three, as links, with hrefs.
 *
 * So the assertions here are exact counts against a hand-computed fixture, never ">= 0" and never
 * "did not throw". A harness bug should fail a test, not produce a table.
 */

const NUL = "\u0000";

/** Five references, hand-picked so the expected answer is countable by eye. */
const IR_WRAPPER = {
  ir: {
    meta: { title: "t" },
    steps: [
      { id: "s1", action: "navigate", target: { url: "/login" } },              // no role+name
      { id: "s2", action: "fill", target: { role: "textbox", name: "Email" } },      // present
      { id: "s3", action: "fill", target: { role: "textbox", name: "Password" } },   // present
      { id: "s4", action: "click", target: { role: "button", name: "Sign In" } },    // present
      { id: "s5", action: "click", target: { role: "link", name: "Forgot" } },       // DROPPED
      { id: "s6", action: "assert", target: { role: "link", name: "Help" }, assertion: "visible" }, // DROPPED
      { id: "s7", action: "assert", assertion: "url_contains", value: "/home" },  // page-level
    ],
  },
  updatedAppModel: { pages: [] },
};

/** A stand-in View carrying exactly the three that survived. */
const viewWith = (els: { role: string; name: string }[]) =>
  ({ text: "", warnings: [], ids: new Map(els.map((e, i) => [String(i), e as any])) }) as any;

const KEPT = [
  { role: "textbox", name: "Email" },
  { role: "textbox", name: "Password" },
  { role: "button", name: "Sign In" },
];
/** Everything the source model held — all five, so none is excluded as live-extended. */
const SOURCE = new Set([...KEPT, { role: "link", name: "Forgot" }, { role: "link", name: "Help" }]
  .map((e) => elKey(e.role, e.name)));

describe("measureView — irReferences", () => {
  it("unwraps {ir, updatedAppModel} rather than reading .steps off the wrapper", () => {
    expect(irReferences(IR_WRAPPER)).toHaveLength(5);
  });

  it("accepts a bare IR too, so both saved shapes work", () => {
    expect(irReferences(IR_WRAPPER.ir)).toHaveLength(5);
  });

  it("ignores steps with no role+name — page-level assertions target nothing", () => {
    const keys = irReferences(IR_WRAPPER).map((r) => r.key);
    expect(keys).not.toContain(elKey(undefined, undefined));
    expect(keys).toContain(elKey("button", "Sign In"));
  });
});

describe("measureView — coverage", () => {
  it("scores exactly 3 of 5, not 'more than zero'", () => {
    const c = coverage(viewWith(KEPT), irReferences(IR_WRAPPER), SOURCE);
    expect(c.pct).toBeCloseTo(3 / 5, 10);
    expect(c.missing.sort()).toEqual([`link "Forgot"`, `link "Help"`]);
  });

  it("THROWS on zero references instead of returning a figure", () => {
    // Bug 1 returned 1 here, which read as a perfect score. Refusing is the only safe answer.
    expect(() => coverage(viewWith(KEPT), [], SOURCE)).toThrow(/no references/i);
  });

  it("throws when every reference is live-extended, rather than scoring 100%", () => {
    // Nothing in the IR was in the source model, so there is nothing this View could have carried.
    expect(() => coverage(viewWith(KEPT), irReferences(IR_WRAPPER), new Set())).toThrow(/no references/i);
  });

  it("excludes live-extended references instead of counting them as failures", () => {
    // "Help" was never in the source model, so it cannot be a coverage failure: 3 of 4, not 3 of 5.
    const source = new Set([...SOURCE].filter((k) => k !== elKey("link", "Help")));
    const c = coverage(viewWith(KEPT), irReferences(IR_WRAPPER), source);
    expect(c.pct).toBeCloseTo(3 / 4, 10);
    expect(c.missing).toEqual([`link "Forgot"`]);
  });
});

describe("measureView — the prompt is three blocks, not one (bug 4)", () => {
  const model: any = {
    baseUrl: "https://x.test",
    pages: [{
      url: "https://x.test/",
      title: "Home",
      concepts: [],
      // The IR grounds against link "Services", which is NOT here...
      elements: [{ role: "button", name: "Go" }],
      // ...but IS in the nav tree, which toMicroModel emits into the same prompt.
      navigation: [{ text: "Services", role: "link", href: "https://x.test/#services", children: [] }],
      forms: [{ fields: [{ label: "Email" }] }],
    }],
  };
  const ir = { ir: { steps: [
    { id: "s1", action: "click", target: { role: "link", name: "Services" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Email" } },
  ] } };

  it("counts an element present ONLY in the nav tree as reaching the model", () => {
    const r = checkMicroBaseline(model, ir, { feature: "Nav" }, "https://x.test/");
    expect(r.missing.map((m) => m.label)).not.toContain(`link "Services"`);
  });

  it("counts a field present ONLY as a form label as reaching the model", () => {
    const r = checkMicroBaseline(model, ir, { feature: "Nav" }, "https://x.test/");
    expect(r.missing.map((m) => m.label)).not.toContain(`textbox "Email"`);
  });

  it("reports nothing missing for this fixture at all", () => {
    const r = checkMicroBaseline(model, ir, { feature: "Nav" }, "https://x.test/");
    expect(r.refs).toBe(2);
    expect(r.missing).toEqual([]);
  });
});

describe("measureView — elKey is the only key construction (bug 2's root cause)", () => {
  const src = readFileSync("scripts/measureView.ts", "utf8");

  it("builds no (role, name) key by hand anywhere in the file", () => {
    // Any template literal pairing a .role with a .name is a second joiner waiting to disagree.
    const handRolled = src.match(/`\$\{[\w.?\s]*\brole\b[^`]*\}\s*.?\s*\$\{[\w.?\s]*\bname\b[^`]*\}`/g) ?? [];
    const offenders = handRolled.filter((m) => !m.includes('"'));   // renderLine's quoted display form is not a key
    expect(offenders).toEqual([]);
  });

  it("contains no raw NUL bytes — they made grep treat the file as binary", () => {
    expect(src.includes(NUL)).toBe(false);
  });

  it("declares the separator exactly once", () => {
    expect(src.match(/const NUL_SEP\s*=/g) ?? []).toHaveLength(1);
  });
});

describe("measureView — hidden inputs never reach the View, at any density", () => {
  /**
   * Found by READING §6's output, not by any metric. The Amazon run's `shared:` line opened with
   * `textbox "SIGNIN_CLAIM_COLLECT"`, `textbox "true"`, `textbox "claimType"` and a live CSRF
   * token, presented as controls a person could type into — and Pass 3 ranks textbox first, so
   * they outranked the real search box. Token reduction, irCoverage and the A/B comparison are all
   * structurally blind to a defect in the INPUT.
   *
   * The accessible name of an unlabelled hidden input is its VALUE, which is why the token looks
   * like it is named after its own contents. So the match is on the hidden field's name AND value.
   */
  const CSRF = "hEj/Wh8642+o8zAEP15lt9A5gFAdyyTAqoNqg9Fa9jHD";

  /** `pad` inflates the element count to move chars-per-element across the 70 threshold. */
  const modelWith = (pad: number, pages = 1) => ({
    baseUrl: "https://x.test",
    pages: Array.from({ length: pages }, (_, pi) => ({
      url: `https://x.test/p${pi}`,
      title: "T",
      concepts: [],
      elements: [
        // Real controls, which must survive.
        { role: "searchbox", name: "Search the site", visible: true },
        { role: "button", name: "Go", visible: true },
        // Hidden inputs. Note SIGNIN_CLAIM_COLLECT is recorded visible:true in real data —
        // filtering on `visible` alone would leave it in.
        { role: "textbox", name: "SIGNIN_CLAIM_COLLECT", visible: true },
        { role: "textbox", name: "claimType", visible: true },
        { role: "textbox", name: CSRF, visible: false },
        ...Array.from({ length: pad }, (_, i) => ({ role: "link", name: `Filler ${i}`, visible: true })),
      ],
      forms: [{ fields: [
        { inputType: "hidden", name: "appAction", value: "SIGNIN_CLAIM_COLLECT" },
        { inputType: "hidden", name: "claimType", value: "" },
        { inputType: "hidden", name: "anti-csrftoken-a2z", value: CSRF },
        { inputType: "text", name: "field-keywords", label: "Search the site" },
      ] }],
    })),
  }) as any;

  for (const pad of [0, 5, 40, 200]) {
    it(`excludes them with ${pad} filler element(s)`, () => {
      const text = buildView(modelWith(pad)).text;
      expect(text).not.toContain("SIGNIN_CLAIM_COLLECT");
      expect(text).not.toContain("claimType");
      expect(text).not.toContain(CSRF);
      // ...while the real control is still there, so this is a filter and not a blanket drop.
      expect(text).toContain("Search the site");
    });
  }

  it("keeps them out of Pass 1's shared hoist, the most prominent line in the View", () => {
    // 3 pages is the minimum for hoisting, and a hidden input present on every sign-in page is
    // exactly what looks like site chrome to a hoist that counts distinct pages.
    const m = modelWith(0, 3);
    const { shared } = hoistShared(m.pages, 3);
    expect(shared.join(" ")).not.toContain("SIGNIN_CLAIM_COLLECT");
    expect(shared.join(" ")).not.toContain(CSRF);
  });

  it("does not rely on `visible` alone — the real data marks half of them visible:true", () => {
    const m = modelWith(0);
    m.pages[0].elements = [{ role: "textbox", name: "SIGNIN_CLAIM_COLLECT", visible: true }];
    expect(buildView(m).text).not.toContain("SIGNIN_CLAIM_COLLECT");
  });
});
