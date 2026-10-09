import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOLEAN_ENV_FLAGS,
  findInvalidBooleanFlags,
  formatInvalidBooleanFlags,
} from "../src/server/index.js";

/**
 * The boot guard that refuses a boolean env flag set to anything but exactly "true"/"false".
 *
 * Why this exists at all: `AUTH_ENABLED=truebro` shipped in a real `.env`. Every one of these
 * flags is read as `x === "true"`, so that typo was silently coerced to `false` — the server
 * booted with authentication off, resolved every visitor as the synthetic local owner, and said
 * nothing at all. A typo in a security flag must not be survivable.
 *
 * `findInvalidBooleanFlags` is pure and takes its environment as an argument precisely so these
 * tests never touch `process.env` or boot a server: the `process.exit(1)` call it feeds lives
 * inside `isMain` in `index.ts`, which importing `app` here deliberately does not trigger.
 *
 * THE LAST TEST USED TO CLAIM MORE THAN IT DID, and TD-100 is what that cost. It compared
 * `BOOLEAN_ENV_FLAGS` against a hardcoded literal of the same names, so it could only catch
 * someone editing the constant without editing the test. A flag added to the CODE and to neither
 * list passed cleanly — which is exactly what happened: `DETERMINISTIC_HEAL` is read as
 * `process.env.DETERMINISTIC_HEAL === "true"` in `heal.ts`, was never registered, and `=1`/`=True`
 * booted clean and silently disabled the cheap structural heal for months.
 *
 * It now SCANS `src/` for the comparison itself. That is not the regex-over-prose failure
 * CLAUDE.md's central rule warns about — the rule is about branching on LLM- or page-authored
 * *text*; this reads our own source, which is structure we control and the only place the truth
 * lives. Known blind spot, stated rather than hidden: `GATE_CASE_EDIT_AI` uses a second, lenient
 * convention (`String(...).toLowerCase() === "true"`) and is deliberately NOT matched — registering
 * it would make `TRUE` fatal when its reader accepts it. See TD-100 on normalising the two.
 */
describe("boolean env flag boot guard", () => {
  describe("one test per flag: a malformed value is rejected and named", () => {
    // Each flag gets its own case, so a failure names the flag that regressed.
    for (const flag of BOOLEAN_ENV_FLAGS) {
      it(`rejects ${flag} set to a non-boolean value`, () => {
        const bad = findInvalidBooleanFlags({ [flag]: "truebro" });
        expect(bad).toEqual([{ name: flag, found: "truebro" }]);
        // The operator has to be able to see WHICH variable and WHAT value.
        const msg = formatInvalidBooleanFlags(bad);
        expect(msg).toContain(flag);
        expect(msg).toContain("truebro");
      });
    }
  });

  describe("one test per flag: both legal values are accepted", () => {
    for (const flag of BOOLEAN_ENV_FLAGS) {
      it(`accepts ${flag}="true" and ${flag}="false"`, () => {
        expect(findInvalidBooleanFlags({ [flag]: "true" })).toEqual([]);
        expect(findInvalidBooleanFlags({ [flag]: "false" })).toEqual([]);
      });
    }
  });

  describe("the values that look deliberate but are not boolean", () => {
    // Present-but-empty is the dangerous one: `FLAG=` reads as false and looks intentional.
    it("rejects a present-but-empty value", () => {
      expect(findInvalidBooleanFlags({ AUTH_ENABLED: "" })).toEqual([
        { name: "AUTH_ENABLED", found: "" },
      ]);
    });

    it("shows an empty value visibly in the message rather than as blank space", () => {
      const msg = formatInvalidBooleanFlags(findInvalidBooleanFlags({ AUTH_ENABLED: "" }));
      expect(msg).toContain('AUTH_ENABLED=""');
    });

    // Guessing at these is how a flag ends up meaning the opposite of what was typed.
    it.each(["TRUE", "True", "1", "yes", "on", "0", "no", " true", "true "])(
      "rejects %j rather than coercing it",
      (value) => {
        expect(findInvalidBooleanFlags({ AUTH_ENABLED: value })).toEqual([
          { name: "AUTH_ENABLED", found: value },
        ]);
      },
    );
  });

  describe("absent is not an error", () => {
    /**
     * CLAUDE.md rule 2: "every new capability ships behind an env flag defaulting to OFF." An
     * unset flag is that documented contract, not a misconfiguration — making it fatal would mean
     * no dev box or CI runner could boot without a fully-populated `.env`.
     */
    it("ignores a flag that is not set at all", () => {
      expect(findInvalidBooleanFlags({})).toEqual([]);
    });

    it("ignores an explicitly-undefined flag", () => {
      expect(findInvalidBooleanFlags({ AUTH_ENABLED: undefined })).toEqual([]);
    });

    it("does not confuse absent with present-but-empty", () => {
      expect(findInvalidBooleanFlags({ SIGNUP_ENABLED: undefined })).toEqual([]);
      expect(findInvalidBooleanFlags({ SIGNUP_ENABLED: "" })).toHaveLength(1);
    });
  });

  describe("reporting", () => {
    it("reports every malformed flag at once, not just the first", () => {
      const bad = findInvalidBooleanFlags({
        AUTH_ENABLED: "truebro",
        DB_ENABLED: "true",
        SIGNUP_ENABLED: "",
        NL_STEPS_ENABLED: "yes",
      });
      expect(bad.map((b) => b.name).sort()).toEqual([
        "AUTH_ENABLED",
        "NL_STEPS_ENABLED",
        "SIGNUP_ENABLED",
      ]);
      const msg = formatInvalidBooleanFlags(bad);
      for (const name of ["AUTH_ENABLED", "NL_STEPS_ENABLED", "SIGNUP_ENABLED"]) {
        expect(msg).toContain(name);
      }
      // A correctly-set flag must not be named in a failure message.
      expect(msg).not.toContain("DB_ENABLED");
    });

    it("ignores env vars that are not declared boolean flags", () => {
      expect(findInvalidBooleanFlags({ PORT: "3000", GEMINI_MODEL: "gemini-2.5-pro" })).toEqual([]);
    });
  });

  describe("the declared list stays in step with the code", () => {
    /**
     * The guard can only check flags it knows about, so the real failure mode is adding a flag to
     * the code and forgetting this list. The "registers"/"declares" tests below assert the declared
     * set matches every flag the server actually compares against "true"/"false" in EITHER
     * direction, which is what TD-100 cost us.
     */

    /**
     * Flags that are DELIBERATELY registered while nothing reads them yet.
     *
     * Every entry here is a capability registered ahead of its reader, so the boot guard already
     * rejects a typo (`DISCOVERY_LIVE_DOM=truebro`) from the moment the flag exists rather than
     * silently reading false. The tests below keep this honest: each name must really be in
     * `BOOLEAN_ENV_FLAGS` (so the guard covers it) AND still be unread (so the moment a reader
     * lands, the stale exemption is caught and removed rather than quietly widening the guard's
     * blind spot forever). See TD-100 for why this list matters at all.
     */
    const RESERVED_FLAGS = ["DISCOVERY_LIVE_DOM", "SALESFORCE_ENABLED"] as const;

    /** Every `process.env.X === "true"` / `!== "false"` in src/, found by reading the source. */
    function flagsTheCodeReads(): string[] {
      const found = new Set<string>();
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          if (!entry.name.endsWith(".ts")) continue;
          const src = readFileSync(full, "utf8");
          for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)\s*(?:===|!==)\s*"(?:true|false)"/g)) {
            found.add(m[1]);
          }
        }
      };
      walk(fileURLToPath(new URL("../src", import.meta.url)));
      return [...found].sort();
    }

    it("registers every flag the code actually compares against a boolean string", () => {
      // The real failure mode, and the one that produced TD-100: a flag added to the code and to
      // no list at all. A hardcoded literal here could never see that.
      const unregistered = flagsTheCodeReads().filter((f) => !BOOLEAN_ENV_FLAGS.includes(f as never));
      expect(unregistered,
        `read as a boolean in src/ but missing from BOOLEAN_ENV_FLAGS, so a typo in them boots `
        + `clean and reads false: ${unregistered.join(", ")}`).toEqual([]);
    });

    it("declares no flag the code no longer reads", () => {
      // The other direction: a stale entry is harmless at runtime but makes the registry lie about
      // what it covers, which is how the previous version of this test came to be believed.
      // RESERVED_FLAGS are the one deliberate exception, and are checked separately below.
      const read = flagsTheCodeReads();
      const stale = [...BOOLEAN_ENV_FLAGS].filter(
        (f) => !read.includes(f) && !RESERVED_FLAGS.includes(f as never),
      );
      expect(stale,
        `declared in BOOLEAN_ENV_FLAGS but read as a boolean nowhere in src/: ${stale.join(", ")}`
      ).toEqual([]);
    });

    it("registers every reserved flag, so the boot guard already covers a typo in it", () => {
      for (const flag of RESERVED_FLAGS) {
        expect(BOOLEAN_ENV_FLAGS, `${flag} must be in BOOLEAN_ENV_FLAGS`).toContain(flag);
        // The whole point of registering ahead of the reader: a typo is fatal NOW, not silently
        // false whenever the reader eventually lands.
        expect(findInvalidBooleanFlags({ [flag]: "truebro" })).toEqual([{ name: flag, found: "truebro" }]);
      }
    });

    it("has no reader for any reserved flag yet, so a stale exemption cannot linger", () => {
      const read = flagsTheCodeReads();
      const nowRead = RESERVED_FLAGS.filter((f) => read.includes(f));
      expect(nowRead,
        `read as a boolean in src/ now — remove from RESERVED_FLAGS so the reverse assertion `
        + `covers it again: ${nowRead.join(", ")}`).toEqual([]);
    });

    it("declares no duplicates", () => {
      expect(new Set(BOOLEAN_ENV_FLAGS).size).toBe(BOOLEAN_ENV_FLAGS.length);
    });
  });
});
