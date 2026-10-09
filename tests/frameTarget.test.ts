import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IR, Target } from "../src/schema/ir.js";
import { AppModel, Element } from "../src/schema/appModel.js";

/**
 * Phase 1 of the live-DOM discovery stream: `Target.frame` and the new optional `Element` fields.
 *
 * The standard being enforced is the one `Target.groundedAt` was added to — additive and
 * optional, so every STORED document still parses and, with `DISCOVERY_LIVE_DOM` off, comes back
 * out byte-identical. "Still parses" is the weak half of that: Zod strips unknown keys, so a
 * parse that silently DROPPED or ADDED a key would pass `safeParse().success` and still be a
 * behaviour change. Hence these compare the parsed result to the stored JSON, not just success.
 *
 * The fixtures are real saved runs (copied out of the gitignored `runs/`), not hand-written, so
 * they cannot drift from what the pipeline actually produced — the same reasoning as
 * `irGroqToGeminiReplay.test.ts`.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

/** Every `*.json` under tests/fixtures, one directory deep. */
function fixtureFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const f of readdirSync(join(FIXTURES, entry.name))) {
      if (f.endsWith(".json")) out.push(join(entry.name, f));
    }
  }
  return out.sort();
}

const load = (rel: string): any => JSON.parse(readFileSync(join(FIXTURES, rel), "utf8"));

describe("Target.frame — additive and optional", () => {
  const irFiles = fixtureFiles().filter((f) => f.endsWith("04-ir.json"));

  it("has real saved IR fixtures to check against", () => {
    // Guard against the loop below passing vacuously if the fixtures move.
    expect(irFiles.length).toBeGreaterThanOrEqual(4);
  });

  it.each(irFiles)("%s: a stored IR parses, and no step target gains or loses a key", (rel) => {
    const raw = load(rel);
    const stored = raw.ir ?? raw; // run-level files wrap { ir, updatedAppModel }
    const parsed = IR.safeParse(stored);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (!parsed.success) return;

    parsed.data.steps.forEach((step, i) => {
      const before = stored.steps[i].target;
      const after = step.target;
      if (!before) { expect(after).toBeUndefined(); return; }
      expect(after).toBeDefined();
      // Exact key-set equality: nothing dropped, and crucially `frame` NOT materialised.
      expect(Object.keys(after!).sort()).toEqual(Object.keys(before).sort());
      expect(after).not.toHaveProperty("frame");
    });
  });

  it("round-trips a frame path untouched", () => {
    const t = Target.parse({ role: "button", name: "Save", css: "#save", frame: "iframe#report" });
    expect(t.frame).toBe("iframe#report");
  });

  it("round-trips a nested frame path, segments joined by ' >>> '", () => {
    const frame = "iframe#outer >>> iframe[name=inner]";
    expect(Target.parse({ css: "#go", frame }).frame).toBe(frame);
  });

  it("does not default a missing frame to an empty string", () => {
    // An empty string would be truthy-checked inconsistently downstream; absent must stay absent.
    expect(Target.parse({ css: "#go" })).not.toHaveProperty("frame");
  });

  it("rejects a non-string frame", () => {
    expect(Target.safeParse({ css: "#go", frame: 3 }).success).toBe(false);
    expect(Target.safeParse({ css: "#go", frame: ["iframe"] }).success).toBe(false);
  });

  it("still accepts groundedAt next to frame — the two provenance/addressing fields coexist", () => {
    const t = Target.parse({ css: "#go", frame: "iframe#f", groundedAt: "replay" });
    expect(t.groundedAt).toBe("replay");
    expect(t.frame).toBe("iframe#f");
  });
});

describe("Element live-DOM fields — additive and optional", () => {
  const appModels: Array<{ label: string; model: any }> = [];
  for (const rel of fixtureFiles()) {
    const raw = load(rel);
    if (rel.endsWith("02-appmodel.json")) appModels.push({ label: rel, model: raw });
    else if (raw?.updatedAppModel) appModels.push({ label: `${rel}#updatedAppModel`, model: raw.updatedAppModel });
  }

  it("has real saved AppModels to check against", () => {
    expect(appModels.length).toBeGreaterThanOrEqual(4);
  });

  it.each(appModels.map((a) => [a.label, a.model] as const))(
    "%s: parses, and no element gains or loses a key",
    (_label, model) => {
      const parsed = AppModel.safeParse(model);
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
      if (!parsed.success) return;

      parsed.data.pages.forEach((page, p) => {
        const storedEls: any[] = model.pages[p].elements ?? [];
        expect(page.elements.length).toBe(storedEls.length);
        page.elements.forEach((el, e) => {
          // None of the live-walker fields may appear on a model the cheerio path produced.
          for (const k of ["frame", "inShadow", "nameSource", "visibleSource"]) {
            expect(el, `${k} must not be materialised`).not.toHaveProperty(k);
          }
          expect(Object.keys(el).sort()).toEqual(Object.keys(storedEls[e]).sort());
        });
      });
    },
  );
});

describe("Element live-DOM fields — round trip", () => {
  it("carries frame, inShadow, nameSource and visibleSource when the live walker sets them", () => {
    const el = Element.parse({
      role: "textbox", name: "Username", css: "#username", visible: true,
      frame: "iframe#login", inShadow: true, nameSource: "label", visibleSource: "computed",
    });
    expect(el).toMatchObject({ frame: "iframe#login", inShadow: true, nameSource: "label", visibleSource: "computed" });
  });

  it("accepts a nameSource the schema has never heard of — a new accname rule must not invalidate a stored model", () => {
    expect(Element.safeParse({ role: "button", name: "Go", nameSource: "some-future-rule" }).success).toBe(true);
  });

  it("only ever accepts visibleSource 'computed'", () => {
    expect(Element.safeParse({ role: "button", name: "Go", visibleSource: "assumed" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 4: a framed target resolves INSIDE its iframe — in the generated spec AND live, alike.
//
// targetResolver.ts (live) and generator.ts (emitted) restate the same locator logic on purpose
// (D-06) and have drifted before (TD-07). This pins the frame handling of both by EXECUTING them
// in a real browser (D-19), the way selectAction.test.ts pins `select`: the generated helpers are
// lifted out of real generated spec text, not reimplemented. Every control in the iframe has a
// SAME-NAMED decoy in the top document, so a path that forgot the frame lands on a decoy and
// reports "top-…" instead of "frame-…".
// ---------------------------------------------------------------------------------------------

import { chromium, type Browser, type Page as PwPage } from "playwright";
import { beforeAll, afterAll } from "vitest";
import { generateSpec } from "../src/stages/generator.js";
import { resolveCode, resolveLive, chooseLive, frameRoot, frameRootCode, frameSegments } from "../src/stages/targetResolver.js";
import { specHelpers } from "./fixtures/specHelpers.js";

const CONTROLS = (who: "top" | "frame") => `
  <button data-k="${who}-go0">Go</button>
  <button data-k="${who}-go1">Go</button>
  <button id="go-css" data-k="${who}-css">Css</button>
  <label for="em">Email</label><input id="em" data-k="${who}-email">
  <input placeholder="Search" data-k="${who}-search">
  <p data-k="${who}-hello">Hello</p>
  <span data-testid="tid" data-k="${who}-tid">Tid</span>
  <label for="s">Plan</label><div class="wrap" data-k="${who}-wrap"><select id="s" data-k="${who}-select"><option>A</option><option>B</option></select></div>
  <button data-k="${who}-clicky" onclick="this.textContent='Clicked'">Clicky</button>`;

describe("Target.frame — generated spec and live resolver agree, inside the frame", () => {
  let browser: Browser;
  let page: PwPage;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  afterAll(async () => { await browser.close(); });

  async function load(): Promise<void> {
    await page.route("http://app.test/**", (r) => r.fulfill({
      contentType: "text/html",
      body: new URL(r.request().url()).pathname === "/inner"
        ? CONTROLS("frame")
        : `${CONTROLS("top")}<iframe id="f" src="/inner"></iframe>`,
    }));
    await page.goto("http://app.test/");
    await page.frameLocator("#f").locator("#em").waitFor();
  }

  // A spec that splices in every helper a resolveCode() expression can call.
  const SPEC = generateSpec({
    meta: { feature: "f", title: "t", priority: "medium", sourcePrompt: "p", baseUrl: "http://app.test" },
    steps: [
      { id: "s1", action: "click", target: { role: "button", name: "Go" } },
      { id: "s2", action: "fill", target: { label: "Email" }, value: "x" },
      { id: "s3", action: "select", target: { role: "combobox", name: "Plan" }, value: "B" },
    ],
  } as any, "artifacts");
  const H = specHelpers(SPEC, ["locate", "field", "choose", "scopeOf"]);

  /** Execute an emitted locator expression the way the spec would. */
  const runCode = (code: string, p: PwPage) =>
    new Function("page", "locate", "field", `return (async () => ${code})();`)(p, H.locate, H.field);

  const FRAMED: Array<[string, any, string | undefined, string]> = [
    ["css", { css: "#go-css" }, undefined, "frame-css"],
    ["role+name", { role: "button", name: "Go" }, undefined, "frame-go0"],
    ["role+name+nth", { role: "button", name: "Go", nth: 1 }, undefined, "frame-go1"],
    ["field hint via label (fill)", { label: "Email" }, "fill", "frame-email"],
    ["field hint via role+name (fill)", { role: "textbox", name: "Email" }, "fill", "frame-email"],
    ["placeholder", { placeholder: "Search" }, undefined, "frame-search"],
    ["text", { text: "Hello" }, undefined, "frame-hello"],
    ["testId", { testId: "tid" }, undefined, "frame-tid"],
  ];

  it.each(FRAMED)("%s: emitted and live both resolve inside the iframe", async (_l, base, action, want) => {
    await load();
    const t = { ...base, frame: "#f" };
    const emitted = resolveCode(t, action);
    expect(emitted).toContain('page.frameLocator("#f")');
    const viaSpec = await runCode(emitted, page);
    const viaLive = await resolveLive(page, t, action);
    expect(await viaSpec.getAttribute("data-k"), `emitted: ${emitted}`).toBe(want);
    expect(await viaLive.getAttribute("data-k"), "live").toBe(want);
  });

  it("the same targets WITHOUT a frame emit exactly what they emitted before frames existed", () => {
    expect(resolveCode({ css: "#go-css" })).toBe('page.locator("#go-css").first()');
    expect(resolveCode({ css: "#x", nth: 2 })).toBe('page.locator("#x").nth(2)');
    expect(resolveCode({ role: "button", name: "Go" })).toBe('(await locate(page, "button", "Go"))');
    expect(resolveCode({ role: "button", name: "Go", nth: 1 })).toBe('(await locate(page, "button", "Go", 1))');
    expect(resolveCode({ label: "Email" }, "fill")).toBe('(await field(page, "Email", "fill"))');
    expect(resolveCode({ placeholder: "Search" })).toBe('page.getByPlaceholder("Search").first()');
    expect(resolveCode({ text: "Hello" })).toBe('page.getByText("Hello").first()');
    expect(resolveCode({ testId: "tid" })).toBe('page.getByTestId("tid").first()');
  });

  it("splits and rebuilds a nested frame path, outermost first", () => {
    expect(frameSegments(undefined)).toEqual([]);
    expect(frameSegments("#a >>> body > iframe")).toEqual(["#a", "body > iframe"]);
    expect(frameRootCode({ frame: "#a >>> body > iframe" })).toBe('page.frameLocator("#a").frameLocator("body > iframe")');
    expect(frameRootCode({})).toBe("page");
  });

  it("a visible assertion on a framed target emits a :visible operand from the SAME frame, and it passes", async () => {
    await load();
    const spec = generateSpec({
      meta: { feature: "f", title: "t", priority: "medium", sourcePrompt: "p", baseUrl: "http://app.test" },
      steps: [{ id: "s1", action: "assert", assertion: "visible", target: { css: "#go-css", frame: "#f" } }],
    } as any, "artifacts");
    const line = spec.split("\n").find((l) => l.includes("toBeVisible"))!;
    const expr = line.match(/expect\((.*)\)\.toBeVisible/)![1];
    // Locator.and() across frames throws; a page-level :visible operand would break this.
    expect(expr).toBe('page.frameLocator("#f").locator("#go-css").and(page.frameLocator("#f").locator(\':visible\')).first()');
    const loc = await runCode(expr, page);
    expect(await loc.count()).toBe(1);
    expect(await loc.getAttribute("data-k")).toBe("frame-css");
  });

  it("a click on a framed role+name target does not route through page-level safeClick", async () => {
    await load();
    const spec = generateSpec({
      meta: { feature: "f", title: "t", priority: "medium", sourcePrompt: "p", baseUrl: "http://app.test" },
      steps: [{ id: "s1", action: "click", target: { role: "button", name: "Clicky", frame: "#f" } }],
    } as any, "artifacts");
    // The action line, not the test.step("Click 'Clicky'") label line above it.
    const line = spec.split("\n").find((l) => l.includes("Clicky") && l.includes(".click("))!;
    expect(line).not.toContain("safeClick");
    expect(line).toContain('locate(page.frameLocator("#f"), "button", "Clicky")');
    await runCode(line.trim().replace(/^await /, "").replace(/;$/, ""), page);
    expect(await page.frameLocator("#f").locator('[data-k="frame-clicky"]').textContent()).toBe("Clicked");
    expect(await page.locator('[data-k="top-clicky"]').textContent()).toBe("Clicky");
  });

  it("select on a wrapper inside the frame picks the FRAME's <select>, in the spec and live", async () => {
    // The wrapper is not a <select>, so choose()/chooseLive re-index the real control by its
    // position in the document. That index must be read in the frame's document: on the page it
    // names the top-level decoy select instead.
    const t = { css: ".wrap", frame: "#f" };
    const spec = generateSpec({
      meta: { feature: "f", title: "t", priority: "medium", sourcePrompt: "p", baseUrl: "http://app.test" },
      steps: [{ id: "s1", action: "select", target: t, value: "B" }],
    } as any, "artifacts");
    const line = spec.split("\n").find((l) => l.includes("await choose("))!;
    expect(line).toContain(', page.frameLocator("#f"));');

    await load();
    await new Function("page", "choose", "locate", "field", `return (async () => { ${line} })();`)(page, H.choose, H.locate, H.field);
    expect(await page.frameLocator("#f").locator("#s").inputValue()).toBe("B");
    expect(await page.locator("#s").inputValue()).toBe("A");

    await load();
    await chooseLive(page, await resolveLive(page, t, "select"), "B", frameRoot(page, t));
    expect(await page.frameLocator("#f").locator("#s").inputValue()).toBe("B");
    expect(await page.locator("#s").inputValue()).toBe("A");
  });

  it("a select WITHOUT a frame emits choose() with three arguments, exactly as before", () => {
    const spec = generateSpec({
      meta: { feature: "f", title: "t", priority: "medium", sourcePrompt: "p", baseUrl: "http://app.test" },
      steps: [{ id: "s1", action: "select", target: { css: ".wrap" }, value: "B" }],
    } as any, "artifacts");
    expect(spec).toContain('await choose(page, page.locator(".wrap").first(), "B");');
  });
});
