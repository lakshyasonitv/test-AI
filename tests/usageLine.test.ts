import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The per-run cost line in the suite header.
 *
 * `08-llm-usage.json` has carried per-stage tokens all along and nothing showed them, so a run's
 * cost was invisible unless you went looking on disk. The terminal event already carries
 * `llmUsage` for both a normal run and a replay, so this needed no new route and no route-shape
 * change — only a place to put it.
 *
 * Tested the same way `stepText.test.ts` pins app.js's `formatIrStep`: the functions are extracted
 * from the SHIPPED `public/app.js` and evaluated, so this cannot pass against a reimplementation
 * that agrees with nothing on screen.
 */

const APP = readFileSync("public/app.js", "utf8");

function extractFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`public/app.js does not define ${name}()`);
  const start = src.lastIndexOf("async ", at) === at - 6 ? at - 6 : at;
  let depth = 0;
  for (let k = src.indexOf("{", at); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(start, k + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}()`);
}

/** Build the pair with the two module globals they read injected as parameters. */
function render(usage: unknown, isReplay: boolean): string {
  const factory = new Function(
    "currentRunUsage", "currentRunIsReplay", "escapeHtml",
    `${extractFn(APP, "fmtTokens")}\n${extractFn(APP, "renderUsageLine")}\nreturn renderUsageLine();`,
  );
  return factory(usage, isReplay, (s: string) => String(s));
}

const REAL_USAGE = {
  // Verbatim from runs/2026-09-01T07-29-30-238Z-a031b900/08-llm-usage.json
  calls: 20, promptTokens: 79183, completionTokens: 11122, totalTokens: 90305, exhausted: false,
  byStage: {
    plan: { calls: 1, promptTokens: 338, completionTokens: 132, totalTokens: 470 },
    discovery: { calls: 1, promptTokens: 340, completionTokens: 124, totalTokens: 464 },
    testcases: { calls: 3, promptTokens: 15361, completionTokens: 5191, totalTokens: 20552 },
    ir: { calls: 14, promptTokens: 60062, completionTokens: 5000, totalTokens: 65062 },
  },
};

describe("renderUsageLine", () => {
  it("shows calls, total tokens and the stage that dominated", () => {
    const html = render(REAL_USAGE, false);
    expect(html).toContain("20 AI calls");
    expect(html).toContain("90k tokens");
    // `ir` is 65,062 of 90,305 — naming it is the actionable half of the number.
    expect(html).toContain("<b>ir</b>");
    expect(html).toContain("14 calls");
  });

  it("says 0 AI calls for a replay, in words", () => {
    // The library's whole economic claim. A bare "0 tokens" reads like missing data.
    const html = render({ calls: 0, totalTokens: 0, byStage: {} }, true);
    expect(html).toContain("<b>0 AI calls</b>");
    expect(html).toMatch(/no tokens spent/i);
    expect(html).toContain("Replayed from saved steps");
  });

  it("renders nothing when there is no usage to show", () => {
    expect(render(null, false)).toBe("");
    expect(render({ calls: 0, totalTokens: 0, byStage: {} }, false)).toBe("");
  });

  it("flags an exhausted budget, because that changes what the results mean", () => {
    expect(render({ ...REAL_USAGE, exhausted: true }, false)).toContain("budget exhausted");
  });

  it("reuses .hrow-meta and mints no new class (rule 3)", () => {
    const html = render(REAL_USAGE, false);
    const classes = [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
    expect(classes).toEqual(["hrow-meta"]);
    expect(readFileSync("public/style.css", "utf8")).toContain(".hrow-meta");
  });

  it("formats token counts at a readable scale", () => {
    const fmt = new Function(`${extractFn(APP, "fmtTokens")}\nreturn fmtTokens;`)() as (n: number) => string;
    expect(fmt(999)).toBe("999");
    expect(fmt(1200)).toBe("1.2k");
    expect(fmt(90305)).toBe("90k");
    expect(fmt(514427)).toBe("514k");   // the amazon discovery call
  });
});
