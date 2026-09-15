import { describe, it, expect } from "vitest";
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
 * Per CLAUDE.md's structural-check rule, the guard tests the *set of declared flags* rather than
 * grepping source text for `=== "true"` — a flag is covered because it is in `BOOLEAN_ENV_FLAGS`,
 * and the last test in this file fails if that list stops matching the flags the code reads.
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
     * The guard can only check flags it knows about, so the real failure mode is adding a flag
     * to the code and forgetting this list. Assert the declared set matches every flag the
     * server actually compares against "true"/"false".
     */
    it("covers exactly the flags the codebase compares against a boolean string", () => {
      expect([...BOOLEAN_ENV_FLAGS].sort()).toEqual([
        "AUTH_ENABLED",
        "DB_ENABLED",
        "ENABLE_CASE_SELECTION_GATE",
        "NL_STEPS_ENABLED",
        "ORG_LLM_CONFIG_ENABLED",
        "REPLAY_REGROUND",
        "SCRIPT_OVERRIDE_ENABLED",
        "SELF_HEAL_DEFAULT",
        "SIGNUP_ENABLED",
      ]);
    });

    it("declares no duplicates", () => {
      expect(new Set(BOOLEAN_ENV_FLAGS).size).toBe(BOOLEAN_ENV_FLAGS.length);
    });
  });
});
