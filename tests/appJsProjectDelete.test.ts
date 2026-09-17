import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The confirmation gate on deleting a project, in `public/app.js`.
 *
 * WHY THIS IS THE TEST WORTH HAVING. `deleteProject` used to refuse with 409 whenever the project
 * held any run, telling the caller to "move or delete them first" — an instruction the product
 * could not satisfy (no move-run route exists, and History lists only the newest 20 runs), so a
 * project could become permanently undeletable. That refusal is gone, and `runs.project_id` ON
 * DELETE SET NULL now leaves runs intact but unfiled.
 *
 * The hazard the refusal was accidentally masking is the cascade: `projects → suites` and
 * `projects → test_cases` are BOTH ON DELETE CASCADE, so deleting a project destroys its entire
 * library and every stored version. Nothing in the schema stops that, and nothing server-side
 * requires a confirmation — this function is the guard, so it is the thing to pin.
 *
 * Extract-and-evaluate, same technique as `tests/stepText.test.ts` and
 * `tests/appJsNewRunBtn.test.ts`: `public/app.js` is a classic script with no module surface.
 */

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function extractFunctionSource(name: string): string {
  let start = APP.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in public/app.js`);
  // Keep the `async ` prefix. Slicing from "function" drops it, and the body's `await` then throws
  // "await is only valid in async functions" — a SyntaxError from the harness, not the code.
  if (APP.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const body = APP.slice(start);
  let depth = 0;
  for (let i = body.indexOf("{"); i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") { depth--; if (depth === 0) return body.slice(0, i + 1); }
  }
  throw new Error(`could not find the end of ${name}`);
}

type Impact = { runs: number; suites: number; cases: number };

/** Run confirmProjectDelete with a stubbed `api` and `prompt`; report the answer and what was shown. */
function runConfirm(opts: {
  name: string;
  typed: string | null;
  impact?: Impact | "fail";
}): Promise<{ ok: boolean; shown: string }> {
  let shown = "";
  const api = async () => {
    if (opts.impact === "fail") throw new Error("boom");
    return opts.impact ?? { runs: 0, suites: 0, cases: 0 };
  };
  const prompt = (msg: string) => { shown = msg; return opts.typed; };

  const src = extractFunctionSource("confirmProjectDelete");
  // eslint-disable-next-line no-new-func
  const fn = new Function("api", "prompt", `${src}; return confirmProjectDelete;`)(api, prompt);
  return fn({ id: "p1", name: opts.name }).then((ok: boolean) => ({ ok, shown }));
}

describe("public/app.js — confirmProjectDelete", () => {
  it("only confirms when the project name is typed back exactly", async () => {
    const impact: Impact = { runs: 4, suites: 2, cases: 9 };

    expect((await runConfirm({ name: "LMS", typed: "LMS", impact })).ok).toBe(true);
    // Trailing whitespace is forgiven; nothing else is.
    expect((await runConfirm({ name: "LMS", typed: "  LMS  ", impact })).ok).toBe(true);

    for (const wrong of ["lms", "LM", "LMS2", "", "yes", "delete"]) {
      expect(
        (await runConfirm({ name: "LMS", typed: wrong, impact })).ok,
        `typing "${wrong}" must not delete the project`,
      ).toBe(false);
    }
  });

  it("treats a cancelled prompt as a refusal", async () => {
    // prompt() returns null on Cancel. `null.trim()` would throw, and a throw here would escape
    // into the click handler rather than quietly cancelling.
    expect((await runConfirm({ name: "LMS", typed: null })).ok).toBe(false);
  });

  it("states the cascade and the different fate of runs", async () => {
    const { shown } = await runConfirm({
      name: "LMS", typed: "LMS", impact: { runs: 4, suites: 2, cases: 9 },
    });
    // The counts, so the number is never a surprise.
    expect(shown).toContain("2 suites");
    expect(shown).toContain("9 saved cases");
    expect(shown).toContain("4 runs");
    // Suites/cases are destroyed; runs are NOT — conflating the two is the whole risk.
    expect(shown).toMatch(/permanently deletes/i);
    expect(shown).toMatch(/kept but unfiled/i);
    // And the consequence a tester would otherwise discover later.
    expect(shown).toMatch(/only admins and owners/i);
  });

  it("uses singular wording for a count of one", async () => {
    const { shown } = await runConfirm({
      name: "P", typed: "P", impact: { runs: 1, suites: 1, cases: 1 },
    });
    // The invariant is singular-vs-plural, not the punctuation around it.
    expect(shown).toContain("1 suite");
    expect(shown).toContain("1 saved case");
    expect(shown).toContain("1 run");
    expect(shown).not.toContain("1 suites");
    expect(shown).not.toContain("1 saved cases");
    expect(shown).not.toContain("1 runs");
  });

  it("says so plainly when the project holds nothing", async () => {
    const { shown } = await runConfirm({
      name: "Empty", typed: "Empty", impact: { runs: 0, suites: 0, cases: 0 },
    });
    expect(shown).toContain("no suites or saved cases");
    expect(shown).toContain("no runs");
  });

  it("still offers the delete when the impact lookup fails", async () => {
    // Refusing to delete because a COUNT failed would reintroduce the dead end this replaced —
    // but the caller must be told the impact is unknown rather than shown a reassuring zero.
    const { ok, shown } = await runConfirm({ name: "LMS", typed: "LMS", impact: "fail" });
    expect(ok).toBe(true);
    expect(shown).toMatch(/could not read what this project holds/i);
    expect(shown).not.toMatch(/no suites or saved cases/i);
  });
});
