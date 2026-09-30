import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Every video mode `playwright.config.ts` can produce is a real `VideoMode` in the PINNED
 * Playwright — checked against the installed type definition, not against memory.
 *
 * WHY THIS TEST EXISTS AND `tsc` DOES NOT COVER IT. `playwright.config.ts` is **not in the
 * TypeScript program** — `npx tsc --showConfig` does not list it. Measured directly: changing the
 * emitted mode to the nonsense value `"on-ish"` produced **zero** type errors, and Playwright
 * would have silently fallen back to its own default with nothing said. That is DECISIONS.md
 * D-19's exact failure — `.filter({ visible: true })` shipped, passed `tsc`, passed a unit test,
 * and was a no-op because the option did not exist in this pinned version.
 *
 * The union is read out of `node_modules` rather than hardcoded here, so a Playwright upgrade that
 * retires a mode fails this test instead of silently disabling recording.
 */

const CONFIG = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
const PW_TYPES = readFileSync(
  new URL("../node_modules/playwright/types/test.d.ts", import.meta.url), "utf8",
);

/** `export type VideoMode = 'off' | 'on' | ...;` straight out of the installed package. */
function installedVideoModes(): string[] {
  const m = PW_TYPES.match(/export type VideoMode = ([^;]+);/);
  if (!m) throw new Error("VideoMode not found in the installed playwright types");
  return m[1].split("|").map((s) => s.trim().replace(/^'|'$/g, ""));
}

/** The string literals on the `video:` line(s) of the config's `use` block. */
function configuredVideoModes(): string[] {
  const start = CONFIG.indexOf("\n    video:");
  if (start < 0) throw new Error("no `video:` entry in playwright.config.ts");
  const stmt = CONFIG.slice(start, CONFIG.indexOf(",\n", CONFIG.indexOf(":", start + 10)));
  // Drop the env-var comparisons ("off"/"on" as VALUES of PLAYWRIGHT_VIDEO are the same strings,
  // which is harmless here — every one of them still has to be a valid mode).
  return [...new Set((stmt.match(/"([a-z-]+)"/g) ?? []).map((s) => s.replace(/"/g, "")))];
}

describe("playwright.config.ts video mode", () => {
  it("emits only modes the pinned Playwright actually accepts", () => {
    const valid = installedVideoModes();
    expect(valid, "sanity: the union should still contain the default").toContain("retain-on-failure");
    for (const mode of configuredVideoModes()) {
      expect(valid, `"${mode}" is not a VideoMode in this Playwright — it would silently no-op`)
        .toContain(mode);
    }
  });

  it("still offers 'on', which is the only mode that records a case Playwright passes", () => {
    // blocked / truncated / truncated_no_assertion are all outcomes where PLAYWRIGHT PASSED and
    // the pipeline reclassified afterwards. Under retain-on-failure their recordings are already
    // deleted by then, so "on" is what makes a video possible for those cards at all.
    expect(installedVideoModes()).toContain("on");
    expect(configuredVideoModes()).toContain("on");
  });

  it("keeps retain-on-failure as the DEFAULT — a video per case is not free", () => {
    // The fallback arm of the ternary, i.e. what an unset PLAYWRIGHT_VIDEO gets.
    expect(CONFIG).toMatch(/:\s*"retain-on-failure",/);
    expect(CONFIG).not.toMatch(/video:\s*"on"\s*,/);
  });

  it("lets 'off' win over 'on', because ffmpeg-missing is a capability limit, not a preference", () => {
    // executor.ts sets PLAYWRIGHT_VIDEO=off when the binary is absent; recording starts at CONTEXT
    // creation, so honouring "on" there would break the run outright rather than degrade (TD-71).
    const off = CONFIG.indexOf('=== "off"');
    const on = CONFIG.indexOf('=== "on"');
    expect(off).toBeGreaterThan(-1);
    expect(on).toBeGreaterThan(-1);
    expect(off, '"off" must be tested before "on"').toBeLessThan(on);
  });
});
