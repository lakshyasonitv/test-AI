import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The "New run" button's enabled/disabled state in `public/app.js`.
 *
 * WHAT BROKE. `refreshNewRunState()` disables the button when the workspace is already fresh —
 * no run open, nothing in flight, both composer fields empty — with the title "You're already on
 * a new chat". That is correct. But `fresh` is computed from `currentRunId`, and the only place
 * that variable is set to a real id is `connectToRun()`, which did not recompute anything. So
 * opening a run from history, or loading `#/run/<id>` directly, left the button holding the
 * disabled state it had while the workspace was empty — with a run plainly on screen. Its click
 * handler early-returns on `btn.disabled`, so the button was simply dead: clicking it did nothing,
 * with no error and no log line. Reported as "the new run button is not working".
 *
 * WHY THESE TWO TESTS. The defect was a MISSING CALL SITE, not wrong logic — `refreshNewRunState`
 * itself was always correct, which is why nothing caught it. So the first test pins the call site
 * (source-level, the only thing that can express "this function is invoked here"), and the second
 * pins the logic it depends on by extracting and evaluating it against a fake DOM, using the same
 * technique as `tests/stepText.test.ts` and `tests/appJsVerdict.test.ts`.
 *
 * `public/app.js` is a classic script with no module surface, so extraction is the only way to
 * reach either of them from a test.
 */

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

/**
 * Strip `//` line comments so a search finds CODE, not prose.
 *
 * This is not cosmetic. The first version of this file asserted on the raw source and passed with
 * the fix deleted, because the explanatory comment beside the call contains the words
 * `refreshNewRunState()` — the test was reading its own documentation. Verified by deleting the
 * call line and watching it still go green, which is the check CLAUDE.md asks for ("don't assume
 * a passing test proves a fix") and the only reason this was caught.
 *
 * Naive about `//` inside string literals; adequate here because the functions searched contain
 * no such literal, and the alternative is a parser for one assertion.
 */
function stripLineComments(src: string): string {
  return src.split("\n").map((line) => {
    const i = line.indexOf("//");
    return i < 0 ? line : line.slice(0, i);
  }).join("\n");
}

/** Slice a top-level `function name(...)` out of app.js, balanced-brace style. */
function extractFunctionSource(name: string): string {
  const start = APP.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in public/app.js`);
  const body = APP.slice(start);
  let depth = 0;
  for (let i = body.indexOf("{"); i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") { depth--; if (depth === 0) return body.slice(0, i + 1); }
  }
  throw new Error(`could not find the end of ${name}`);
}

describe("public/app.js — New run button", () => {
  it("connectToRun() recomputes the button state after setting currentRunId", () => {
    // Comments stripped: the call sits next to a comment that names the same function, and
    // searching the raw text finds the prose whether or not the call is there.
    const source = stripLineComments(extractFunctionSource("connectToRun"));

    // The assignment is what invalidates the previously-computed `fresh`, so the recompute has to
    // come after it — asserting mere presence would pass on a call placed above the assignment,
    // where it would read the OLD id and change nothing.
    const assignedAt = source.indexOf("currentRunId = runId");
    const refreshedAt = source.indexOf("refreshNewRunState()");

    expect(assignedAt, "connectToRun should still set currentRunId").toBeGreaterThan(-1);
    expect(
      refreshedAt,
      "connectToRun must call refreshNewRunState() — without it the New Run button keeps the " +
        "disabled state it had before the run was opened, and its click handler then early-" +
        "returns on btn.disabled, making the button dead on every path that reaches a run " +
        "without going through the composer",
    ).toBeGreaterThan(-1);
    expect(refreshedAt, "the recompute must come AFTER currentRunId is assigned").toBeGreaterThan(assignedAt);
  });

  it("refreshNewRunState() enables the button whenever a run is open", () => {
    // A stand-in for the two composer fields and the button. Only the properties the function
    // actually touches are modelled; `disabled` is a real boolean so the `typeof` guard passes.
    const btn = { disabled: false, title: "", attrs: {} as Record<string, string>,
                  setAttribute(k: string, v: string) { this.attrs[k] = v; } };
    const promptEl = { value: "" };
    const urlEl = { value: "" };

    const run = (currentRunId: string | null, runInFlight: boolean) => {
      btn.disabled = false;
      // eslint-disable-next-line no-new-func
      new Function(
        "document", "promptEl", "urlEl", "currentRunId", "runInFlight",
        `${extractFunctionSource("refreshNewRunState")}; refreshNewRunState();`,
      )({ getElementById: () => btn }, promptEl, urlEl, currentRunId, runInFlight);
      return btn.disabled;
    };

    // The empty workspace — the one case that SHOULD disable it.
    expect(run(null, false)).toBe(true);
    expect(btn.title).toBe("You're already on a new chat");

    // A run is open. This is the regression: before the fix the button was left disabled here,
    // because nothing recomputed after connectToRun() set the id.
    expect(run("2026-09-16T10-14-09-905Z-0bb5a291", false)).toBe(false);
    expect(btn.title).toBe("Start a new run");

    // In flight, and typing in either field, also mean "not fresh".
    expect(run(null, true)).toBe(false);
    promptEl.value = "test the login form";
    expect(run(null, false)).toBe(false);
    promptEl.value = "";
    urlEl.value = "example.com";
    expect(run(null, false)).toBe(false);
  });
});
