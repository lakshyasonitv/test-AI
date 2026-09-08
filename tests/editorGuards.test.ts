import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { caseElementContext } from "../src/stages/caseEdit.js";
import { llmCacheSet, llmCacheClear } from "../src/kb/llmCache.js";
import { WALK_CACHE_NS, mergePageInto } from "../src/stages/liveExtend.js";
import { hasTerminalAssertion } from "../src/stages/ir.js";
import { IR } from "../src/schema/ir.js";
import { AppModel } from "../src/schema/appModel.js";

/**
 * Three editor guards — TECH_DEBT.md TD-89 (a case that checks nothing), TD-88 (page merge by
 * exact URL) and TD-91 (a rewrite that cannot see the site).
 */

const irOf = (steps: unknown[], meta: Record<string, unknown> = {}) => IR.parse({
  meta: {
    feature: "admin", title: "Log in and navigate to the admin panel",
    priority: "high", sourcePrompt: "p", baseUrl: "https://learnvibes.vercel.app", ...meta,
  },
  steps,
});

const LOGIN_STEPS = [
  { id: "s1", action: "navigate", target: { url: "/login" } },
  { id: "s2", action: "fill", target: { role: "textbox", name: "you@thinkvibes.com" }, value: "${env:TEST_USERNAME}" },
  { id: "s3", action: "click", target: { role: "button", name: "Sign In" } },
];

describe("TD-89 — a case that verifies nothing", () => {
  it("hasTerminalAssertion sees the assertion, and sees it go", () => {
    const withCheck = irOf([...LOGIN_STEPS, { id: "s4", action: "assert", target: { text: "Welcome" }, assertion: "visible" }]);
    expect(hasTerminalAssertion(withCheck.steps)).toBe(true);
    expect(hasTerminalAssertion(irOf(LOGIN_STEPS).steps)).toBe(false);
  });

  it("a login case that never asserted is not suddenly refused", () => {
    // The over-reach caught by six existing library tests: deriving "did it have one?" from the
    // stale `meta.hasTerminalAssertion` flag refused every edit to a case that never had a check.
    // Deriving it from the STORED STEPS is what makes editing an email stay instant.
    const noCheck = irOf(LOGIN_STEPS, { hasTerminalAssertion: true });   // stale flag, no assertion
    expect(hasTerminalAssertion(noCheck.steps)).toBe(false);
  });
});

describe("TD-91 — the rewrite can see the site", () => {
  // A TEMP runs directory, never the real one. vitest runs files in parallel, and fixtures
  // written into `runs/` are visible to whatever else is listing it — which is exactly how this
  // suite first made an unrelated /api/runs test return 500.
  let runsDir: string;
  const NS = WALK_CACHE_NS;

  beforeEach(() => { runsDir = mkdtempSync(path.join(tmpdir(), "runs-")); llmCacheClear(NS); });
  afterEach(() => { llmCacheClear(NS); rmSync(runsDir, { recursive: true, force: true }); });

  const writeRunModel = (runId: string, model: unknown) => {
    const dir = path.join(runsDir, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "02-appmodel.json"), JSON.stringify(model));
  };

  const MODEL = {
    baseUrl: "https://learnvibes.vercel.app",
    pages: [{
      url: "https://learnvibes.vercel.app/dashboard", title: "Dashboard", concepts: [],
      elements: [
        // The real control, and the heading the model guessed instead.
        { role: "button", name: "Admin" },
        { role: "heading", name: "Admin Panel" },
        { role: "link", name: "Courses" },
        { role: "textbox", name: "Search" },
        { role: "paragraph", name: "Some body copy nobody can click" },
      ],
    }],
  };

  it("offers the real control and NOT the heading it was confused with", () => {
    const runId = `test-rewrite-${Date.now()}`;
    writeRunModel(runId, MODEL);
    const ctx = caseElementContext(irOf(LOGIN_STEPS), runId, runsDir);
    expect(ctx.source).toBe("run");
    expect(ctx.lines).toContain('button "Admin"');
    // A heading is not something a step can click. Offering it is what produced
    // `Click on button "Admin Panel"` for a control that does not exist.
    expect(ctx.lines).not.toContain('heading "Admin Panel"');
    expect(ctx.lines.join("\n")).not.toContain("Admin Panel");
    expect(ctx.lines.join("\n")).not.toContain("body copy");
  });

  it("keeps the actionable roles a step can really use", () => {
    const runId = `test-rewrite-${Date.now()}`;
    writeRunModel(runId, MODEL);
    const ctx = caseElementContext(irOf(LOGIN_STEPS), runId, runsDir);
    expect(ctx.lines).toContain('link "Courses"');
    expect(ctx.lines).toContain('textbox "Search"');
  });

  it("falls back to cached walk snapshots for the same site when there is no run", () => {
    // The common case: the source run folder has aged off disk, which is exactly when the model
    // most needs help. Walk entries are keyed by an opaque hash, so they are enumerated and
    // filtered by SITE.
    llmCacheSet("some-opaque-key", {
      reachedUrl: "https://learnvibes.vercel.app/dashboard",
      pageModel: { url: "https://learnvibes.vercel.app/dashboard", title: "d", concepts: [], elements: [{ role: "button", name: "Admin" }] },
      pageText: "",
    }, NS);
    const ctx = caseElementContext(irOf(LOGIN_STEPS), null, runsDir);
    expect(ctx.source).toBe("walks");
    expect(ctx.lines).toContain('button "Admin"');
  });

  it("ignores a cached walk for a DIFFERENT site", () => {
    llmCacheSet("other-site", {
      reachedUrl: "https://something-else.example/dash",
      pageModel: { url: "https://something-else.example/dash", title: "d", concepts: [], elements: [{ role: "button", name: "Nope" }] },
      pageText: "",
    }, NS);
    const ctx = caseElementContext(irOf(LOGIN_STEPS), null, runsDir);
    expect(ctx.source).toBe("none");
    expect(ctx.lines).toEqual([]);
  });

  it("says so, rather than pretending, when it knows nothing", () => {
    const ctx = caseElementContext(irOf(LOGIN_STEPS), null, runsDir);
    expect(ctx.source).toBe("none");
    expect(ctx.lines).toEqual([]);
  });

  it("caps the list, dropping from the end", () => {
    const many = {
      baseUrl: "https://learnvibes.vercel.app",
      pages: [{
        url: "https://learnvibes.vercel.app/x", title: "x", concepts: [],
        elements: Array.from({ length: 2000 }, (_, i) => ({ role: "button", name: `Button number ${i}` })),
      }],
    };
    const runId = `test-rewrite-cap-${Date.now()}`;
    writeRunModel(runId, many);
    const ctx = caseElementContext(irOf(LOGIN_STEPS), runId, runsDir);
    expect(ctx.lines.join("\n").length).toBeLessThanOrEqual(4000);
    expect(ctx.lines[0]).toBe('button "Button number 0"');   // the earliest survive
  });

  it("drops a name long enough to be page text rather than a label (TD-73's lesson)", () => {
    const runaway = {
      baseUrl: "https://learnvibes.vercel.app",
      pages: [{
        url: "https://learnvibes.vercel.app/x", title: "x", concepts: [],
        elements: [{ role: "button", name: "x".repeat(5000) }, { role: "button", name: "Fine" }],
      }],
    };
    const runId = `test-rewrite-long-${Date.now()}`;
    writeRunModel(runId, runaway);
    const ctx = caseElementContext(irOf(LOGIN_STEPS), runId, runsDir);
    expect(ctx.lines).toEqual(['button "Fine"']);
  });

  it("de-duplicates the same control seen on several pages", () => {
    const dupes = {
      baseUrl: "https://learnvibes.vercel.app",
      pages: [
        { url: "https://learnvibes.vercel.app/a", title: "a", concepts: [], elements: [{ role: "button", name: "Admin" }] },
        { url: "https://learnvibes.vercel.app/b", title: "b", concepts: [], elements: [{ role: "button", name: "Admin" }] },
      ],
    };
    const runId = `test-rewrite-dupe-${Date.now()}`;
    writeRunModel(runId, dupes);
    const ctx = caseElementContext(irOf(LOGIN_STEPS), runId, runsDir);
    expect(ctx.lines.filter((l) => l === 'button "Admin"')).toHaveLength(1);
  });

  it("the proposal carries the parse check the translate path always had", () => {
    // Source-level, because reaching it needs a Gemini call. What must not drift is that
    // `proposeRewrite` runs every line through the SAME parser the save path uses, instead of
    // showing a clean diff that only fails when Save is pressed.
    const src = readFileSync("src/server/rewrite.ts", "utf8");
    const at = src.indexOf("export async function proposeRewrite");
    const body = src.slice(at, src.indexOf("export ", at + 10));
    expect(body).toContain("parseIrStep(steps[i]");
    expect(body).toContain("unreadableIndexes");
    expect(body).toContain("caseElementContext");
  });
});

describe("TD-88 — a refreshed page replaces the stale one", () => {
  const stale = (url: string) => ({
    url, title: "old", concepts: [], elements: [{ role: "button", name: "Stale" }],
  });
  const fresh = {
    url: "https://x.app/", title: "new", concepts: [], elements: [{ role: "button", name: "Fresh" }],
  };
  const modelWith = (...pages: unknown[]) => AppModel.parse({ baseUrl: "https://x.app", pages });

  it("a trailing slash is the same page — the stale copy does not survive", () => {
    // The defect exactly: the filter used `p.url !== reachedUrl` while every LOOKUP uses pageKey,
    // so `https://x.app` stayed beside a fresh `https://x.app/` and `find` returned the stale one.
    const merged = mergePageInto(modelWith(stale("https://x.app")), fresh, "https://x.app/");
    expect(merged.pages).toHaveLength(1);
    expect(merged.pages[0].elements[0].name).toBe("Fresh");
  });

  it("a scheme change is the same page too", () => {
    const merged = mergePageInto(modelWith(stale("http://x.app/")), fresh, "https://x.app/");
    expect(merged.pages).toHaveLength(1);
    expect(merged.pages[0].elements[0].name).toBe("Fresh");
  });

  it("a query string does not make it a different page", () => {
    const merged = mergePageInto(modelWith(stale("https://x.app/?next=1")), fresh, "https://x.app/");
    expect(merged.pages).toHaveLength(1);
  });

  it("a genuinely different page is left alone", () => {
    const merged = mergePageInto(
      modelWith(stale("https://x.app/other")), fresh, "https://x.app/");
    expect(merged.pages.map((p) => p.url).sort())
      .toEqual(["https://x.app/", "https://x.app/other"]);
  });

  it("the walker has no exact-string reachedUrl comparisons left", () => {
    const src = readFileSync("src/stages/liveExtend.ts", "utf8");
    expect(src).not.toMatch(/p\.url === reachedUrl/);
    expect(src).not.toMatch(/p\.url !== reachedUrl/);
  });
});
