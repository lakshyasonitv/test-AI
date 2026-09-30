import { describe, it, expect } from "vitest";
import { findInvalidBrowserEnv, formatInvalidBrowserEnv } from "../src/server/index.js";
import { SUPPORTED_RUN_LOCALES } from "../src/browserLaunch.js";

/**
 * The boot guard for `RUN_LOCALE` / `RUN_TIMEZONE` — TECH_DEBT.md TD-104.
 *
 * WHAT IT WAS. `browserContextOptions()` hands both straight to Chromium. `SUPPORTED_RUN_LOCALES`
 * existed and was enforced, but ONLY on `options.locale` in `POST /api/runs`. The ENVIRONMENT path
 * had no check at all, and `RUN_TIMEZONE` had none anywhere.
 *
 * WHY FATAL AND NOT A WARNING — measured in a real Chromium on the pinned 1.49.0, not inferred:
 *
 *     RUN_TIMEZONE=Asia/Kolkata   -> context OK
 *     RUN_TIMEZONE=Asia/Kolkatta  -> browserContext.newPage: Invalid timezone ID: Asia/Kolkatta
 *     RUN_LOCALE=en_US            -> context OK, silently pinned to the wrong thing
 *
 * The timezone case is TD-71 again, down to the same function in the same error string: pinning
 * happens at CONTEXT creation, so it does not degrade to "unpinned" — every case in every run dies
 * before a single `page.goto`, `screenshot: "on"` photographs a page that never navigated, and the
 * product reports the site under test as broken. A container that boots happily and then blames a
 * working site is strictly worse than one that refuses to boot.
 *
 * `findInvalidBrowserEnv` takes its environment as an argument for the same reason its two siblings
 * do: the `process.exit(1)` lives inside `isMain`, which importing `app` here never triggers, so
 * these tests neither touch `process.env` nor boot a server.
 */

describe("findInvalidBrowserEnv", () => {
  it("rejects the typo that would kill every run, and names it", () => {
    // The whole point. One transposed letter in a var a teammate sets over the Azure CLI.
    const bad = findInvalidBrowserEnv({ RUN_TIMEZONE: "Asia/Kolkatta" });
    expect(bad.map((b) => b.name)).toEqual(["RUN_TIMEZONE"]);
    const msg = formatInvalidBrowserEnv(bad);
    expect(msg).toContain("RUN_TIMEZONE");
    expect(msg).toContain("Asia/Kolkatta");
    // The operator must learn the CONSEQUENCE, or they will read "invalid timezone" as cosmetic.
    expect(msg).toContain("browserContext.newPage()");
  });

  it("accepts real IANA zones, INCLUDING aliases and UTC", () => {
    // Asia/Kolkata and UTC are the two that break the obvious implementation:
    // Intl.supportedValuesOf("timeZone") is canonical-only, so it lists Asia/Calcutta and omits
    // UTC entirely — and UTC is this project's own DEFAULT_TIMEZONE. An allow-list guard would
    // have refused to boot on a correct config, which is worse than the bug it was written for.
    for (const tz of ["UTC", "Asia/Kolkata", "Asia/Calcutta", "Europe/London", "America/New_York"]) {
      expect(findInvalidBrowserEnv({ RUN_TIMEZONE: tz }), `${tz} was rejected`).toEqual([]);
    }
  });

  it("rejects a locale the route would reject, closing the env/route asymmetry", () => {
    // `en_US` (underscore for hyphen) is the single most likely slip, and Chromium ACCEPTS it —
    // measured. So nothing downstream would ever complain; this guard is the only chance to catch it.
    const bad = findInvalidBrowserEnv({ RUN_LOCALE: "en_US" });
    expect(bad.map((b) => b.name)).toEqual(["RUN_LOCALE"]);
    expect(formatInvalidBrowserEnv(bad)).toContain("en-US"); // the hint lists the real tags
  });

  it("accepts every locale the route accepts — one list, not two", () => {
    for (const locale of SUPPORTED_RUN_LOCALES) {
      expect(findInvalidBrowserEnv({ RUN_LOCALE: locale }), `${locale} was rejected`).toEqual([]);
    }
  });

  it("treats ABSENT as legal, like every other env guard in this file", () => {
    expect(findInvalidBrowserEnv({})).toEqual([]);
  });

  it("keeps RUN_LOCALE='' legal — it is the documented rollback switch, not a typo", () => {
    // browserLaunch.ts returns {} for explicitly-empty, meaning "pin nothing". Rejecting it would
    // remove the escape hatch that makes locale pinning safe to default ON.
    expect(findInvalidBrowserEnv({ RUN_LOCALE: "" })).toEqual([]);
    expect(findInvalidBrowserEnv({ RUN_LOCALE: "   " })).toEqual([]);
  });

  it("treats an empty RUN_TIMEZONE as absent rather than as an invalid zone", () => {
    expect(findInvalidBrowserEnv({ RUN_TIMEZONE: "" })).toEqual([]);
  });

  it("reports BOTH when both are wrong, instead of stopping at the first", () => {
    const bad = findInvalidBrowserEnv({ RUN_LOCALE: "klingon", RUN_TIMEZONE: "Mars/Olympus" });
    expect(bad.map((b) => b.name).sort()).toEqual(["RUN_LOCALE", "RUN_TIMEZONE"]);
    const msg = formatInvalidBrowserEnv(bad);
    expect(msg).toContain("klingon");
    expect(msg).toContain("Mars/Olympus");
  });

  it("says how to get back to a working state", () => {
    const msg = formatInvalidBrowserEnv(findInvalidBrowserEnv({ RUN_TIMEZONE: "Nowhere/Nothing" }));
    expect(msg).toContain("FATAL");
    expect(msg).toMatch(/remove the variable/i);
  });
});
