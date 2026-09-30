import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The "test stopped partway through" explanation must come from the STRUCTURED kind, not the note.
 *
 * WHAT HAPPENED. `renderEnterpriseDiagnostic` regexed the truncation note for
 * `/admin|role|permission|authorized/i` and, on a match, told the user: "It signed in
 * successfully, but couldn't find the Admin section on the page. This usually means the account it
 * used doesn't have Admin access."
 *
 * ARIA notes say **role** constantly — "no element with role=button and name=…". So on a real
 * saucedemo run (a shopping site with no admin area whatsoever) it matched "role" and produced a
 * confident, entirely invented explanation. The worst kind of wrong: authoritative and specific.
 *
 * `IR.meta.truncationKind` exists precisely to prevent this, and says so in its own schema comment:
 * pattern-matching the note "is exactly the failure CLAUDE.md's central rule and TECH_DEBT.md TD-01
 * record, so the decision reads this instead". The UI was the one place still doing it.
 *
 * Source-level, because `renderEnterpriseDiagnostic` writes into module-scope DOM handles that
 * cannot be evaluated in isolation. The assertions are therefore about what the code MAY NOT do,
 * which is the durable part.
 */

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function fn(name: string): string {
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

/** Strip `//` comments so a match is code, not the prose explaining the fix. */
const code = (s: string) =>
  s.split("\n").map((l) => { const i = l.indexOf("//"); return i < 0 ? l : l.slice(0, i); }).join("\n");

const BODY = code(fn("renderEnterpriseDiagnostic"));

describe("truncation explanation — structure, not prose", () => {
  it("no longer invents an Admin-access story", () => {
    // The exact sentence a user was shown for a shopping-cart test.
    expect(APP).not.toContain("Admin section on the page");
    expect(APP).not.toContain("doesn't have Admin access");
  });

  it("does not pattern-match the note to choose an explanation", () => {
    // The specific regex, and the general shape. `role` is the word that made it misfire, and it
    // appears in almost every ARIA-derived note.
    expect(BODY).not.toMatch(/\/[^/\n]*\badmin\b[^/\n]*\/i\s*\.test/);
    expect(BODY).not.toMatch(/\.test\(\s*note/);
    expect(BODY).not.toMatch(/\.test\(\s*\(?\s*note\s*\|\|/);
  });

  it("reads truncationKind, from either place it is carried", () => {
    // The done payload lifts it alongside truncationNote; ir.meta has it regardless. Reading both
    // means an older event without the top-level field still gets the right wording.
    expect(BODY).toContain("truncationKind");
    expect(BODY).toMatch(/data\?\.truncationKind\s*\|\|\s*data\?\.ir\?\.meta\?\.truncationKind/);
  });

  it("handles every kind the grounding layer actually emits", () => {
    // ir.ts emits exactly these: navigate-url, text-target, incomplete-coverage, and role-name
    // (the default). A kind with no branch would silently fall to the generic wording.
    for (const kind of ["navigate-url", "text-target", "incomplete-coverage"]) {
      expect(BODY, `no branch for ${kind}`).toContain(`"${kind}"`);
    }
  });

  it("still SHOWS the note in technical details", () => {
    // Displaying prose is fine; interpreting it is not. Removing it would lose the only place the
    // real grounding message is visible.
    expect(BODY).toMatch(/techDetails\s*=\s*note/);
  });
});
