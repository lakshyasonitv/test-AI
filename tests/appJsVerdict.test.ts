import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The run-outcome verdict copy in `public/app.js`.
 *
 * Two sentences in `verdictFor` must stay apart, or this phase's whole point is hidden from the
 * person watching the run:
 *
 *   - "The review round timed out before anything was picked" must render ONLY for a genuine
 *     gate-round timeout (`data.status === "no_cases_selected"` — emitted by the orchestrator
 *     only when `CASE_SELECTION_WAIT_MS` passed with nothing picked).
 *   - A failed testcases stage must render that stage's failure message — e.g.
 *     "The model returned no usable test cases. Raw response saved." or the new
 *     "Azure OpenAI truncated: …" / "Azure OpenAI refusal: …" — never the timeout sentence.
 *
 * Today those are already true (the `stage === "error"` branch runs BEFORE the status checks, and
 * the orchestrator reserves `no_cases_selected` for a real timeout), but nothing pinned it: a
 * future reordering or a "… still means the same thing" edit to the copy could silently blur the
 * two. This file is the pin, using the same extract-and-evaluate technique
 * `tests/stepText.test.ts` uses for `formatIrStep` — `verdictFor` is self-contained (it calls no
 * helpers, only returns objects of strings), so it evaluates cleanly in isolation.
 */

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

type Verdict = { cls: string; ic: string; head: string; detail?: string };

function extractVerdictFor(): (data: any, stage: string, error?: string) => Verdict {
  const start = APP.indexOf("function verdictFor(data, stage, error)");
  if (start < 0) throw new Error("verdictFor not found in public/app.js");
  const body = APP.slice(start);
  let depth = 0, end = -1;
  for (let i = body.indexOf("{"); i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error("could not find the end of verdictFor");
  // eslint-disable-next-line no-new-func
  return new Function(`${body.slice(0, end)}; return verdictFor;`)() as
    (data: any, stage: string, error?: string) => Verdict;
}

const browserVerdict = extractVerdictFor();

const TIMEOUT_PHRASE = "timed out before anything was picked";
const STAGE_FAILURE = "The model returned no usable test cases. Raw response saved.";

describe("verdictFor — the verdict copy stays honest", () => {
  it("finds the browser's verdictFor at all (guards this test from silently passing)", () => {
    expect(typeof browserVerdict).toBe("function");
    expect(browserVerdict({ passed: true }, "done")).toMatchObject({ cls: "passed", head: "Passed" });
  });

  it("a failed testcases stage (an error event) renders the stage's failure message", () => {
    const v = browserVerdict({}, "error", STAGE_FAILURE);
    expect(v.cls).toBe("blocked");
    expect(v.detail).toContain(STAGE_FAILURE);
    expect(v.detail).not.toContain(TIMEOUT_PHRASE);
  });

  it("the timeout sentence renders ONLY for a real gate-round timeout (status no_cases_selected)", () => {
    const v = browserVerdict({ passed: false, status: "no_cases_selected" }, "done", undefined);
    expect(v.head).toBe("No test cases were selected");
    expect(v.detail).toContain(TIMEOUT_PHRASE);
  });

  it("an error event outranks a no_cases_selected status — the failure message wins", () => {
    // Defensive: if a done event ever carried no_cases_selected while stage is "error", the error
    // must win. The orchestrator throws (never emits done) on a failed testcases stage, but the
    // ordering is the guarantee, not this phase's current call pattern.
    const v = browserVerdict({ passed: false, status: "no_cases_selected" }, "error", "real failure");
    expect(v.detail).toContain("real failure");
    expect(v.detail).not.toContain(TIMEOUT_PHRASE);
  });

  it("a bare error event with no message still says the run could not be completed", () => {
    const v = browserVerdict({}, "error", undefined);
    expect(v.cls).toBe("blocked");
    expect(v.detail).toMatch(/The run stopped before it could test anything\./);
    expect(v.detail).not.toContain(TIMEOUT_PHRASE);
  });
});