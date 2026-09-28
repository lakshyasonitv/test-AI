import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  browserContextOptions, localeCacheDimension, withRunLocale,
  isSupportedRunLocale, SUPPORTED_RUN_LOCALES,
} from "../src/browserLaunch.js";
import { specLocaleEnv } from "../src/stages/executor.js";

/**
 * `browserContextOptions` — the resolution ladder, and the rollback switch.
 *
 * Every assertion here is about the returned OBJECT, not about a browser. The companion file
 * `tests/browserLocale.test.ts` is the one that proves the object actually changes what a real
 * Chromium reports, per `DECISIONS.md` D-19 — a Playwright option that looks right is not verified
 * until it has been run once.
 *
 * Env is saved and restored per test on purpose. `tests/apiContract.test.ts` records why: vitest
 * can run several files in one worker process and `process.env` is per-process, so a file that
 * sets a variable and never restores it makes a different file fail on a different run. RUN_LOCALE
 * has a default, so leaking one would not throw — it would quietly assert the wrong thing.
 */

const SAVED = { locale: process.env.RUN_LOCALE, tz: process.env.RUN_TIMEZONE };

beforeEach(() => {
  delete process.env.RUN_LOCALE;
  delete process.env.RUN_TIMEZONE;
});

afterEach(() => {
  if (SAVED.locale === undefined) delete process.env.RUN_LOCALE;
  else process.env.RUN_LOCALE = SAVED.locale;
  if (SAVED.tz === undefined) delete process.env.RUN_TIMEZONE;
  else process.env.RUN_TIMEZONE = SAVED.tz;
});

describe("browserContextOptions — defaults", () => {
  it("defaults to en-US and UTC with nothing set", () => {
    expect(browserContextOptions()).toEqual({ locale: "en-US", timezoneId: "UTC" });
  });

  it("sets NO extraHTTPHeaders — Accept-Language comes from `locale` and cannot be overridden", () => {
    // Measured, not assumed: with `locale` set, Playwright discards an explicit
    // extraHTTPHeaders["Accept-Language"] entirely. Setting one would be a silent no-op of exactly
    // the kind DECISIONS.md D-19 exists for. tests/browserLocale.test.ts proves both directions
    // against a real browser; this pins the shape so nobody re-adds the header here.
    expect(browserContextOptions("de-DE")).not.toHaveProperty("extraHTTPHeaders");
    expect(Object.keys(browserContextOptions("de-DE")).sort()).toEqual(["locale", "timezoneId"]);
  });

  it("takes the timezone from RUN_TIMEZONE when set", () => {
    process.env.RUN_TIMEZONE = "Asia/Kolkata";
    expect(browserContextOptions()).toMatchObject({ locale: "en-US", timezoneId: "Asia/Kolkata" });
  });
});

describe("browserContextOptions — the rollback switch", () => {
  it("returns {} for an EXPLICITLY EMPTY RUN_LOCALE", () => {
    process.env.RUN_LOCALE = "";
    expect(browserContextOptions()).toEqual({});
  });

  it("treats whitespace-only as empty too", () => {
    process.env.RUN_LOCALE = "   ";
    expect(browserContextOptions()).toEqual({});
  });

  it("does NOT treat unset as empty — unset means the default", () => {
    // These are different states and the distinction is the whole feature. If unset meant
    // "unpinned", the fix would be off by default on every machine nobody had configured, which
    // is every machine.
    delete process.env.RUN_LOCALE;
    expect(browserContextOptions()).toMatchObject({ locale: "en-US" });
  });

  it("spreads to nothing, so a `use:` block or newPage() call is unchanged when off", () => {
    process.env.RUN_LOCALE = "";
    expect({ headless: true, ...browserContextOptions() }).toEqual({ headless: true });
  });
});

describe("browserContextOptions — resolution order", () => {
  it("reads RUN_LOCALE when there is no argument and no ambient run", () => {
    process.env.RUN_LOCALE = "ja-JP";
    expect(browserContextOptions()).toMatchObject({ locale: "ja-JP" });
  });

  it("prefers the ambient run locale over RUN_LOCALE", () => {
    process.env.RUN_LOCALE = "ja-JP";
    withRunLocale("fr-FR", () => {
      expect(browserContextOptions()).toMatchObject({ locale: "fr-FR" });
    });
  });

  it("prefers an explicit argument over BOTH the ambient run and the env var", () => {
    process.env.RUN_LOCALE = "ja-JP";
    withRunLocale("fr-FR", () => {
      expect(browserContextOptions("ko-KR")).toMatchObject({ locale: "ko-KR" });
    });
  });

  it("leaves no ambient locale behind once the scope exits", () => {
    process.env.RUN_LOCALE = "ja-JP";
    withRunLocale("fr-FR", () => { /* set, then dropped */ });
    expect(browserContextOptions()).toMatchObject({ locale: "ja-JP" });
  });

  it("an explicit empty argument is the rollback switch too", () => {
    process.env.RUN_LOCALE = "ja-JP";
    expect(browserContextOptions("")).toEqual({});
  });
});

describe("localeCacheDimension", () => {
  it("distinguishes two locales, so a cached snapshot cannot cross between them", () => {
    expect(localeCacheDimension("en-US")).not.toBe(localeCacheDimension("de-DE"));
  });

  it("distinguishes two timezones", () => {
    process.env.RUN_TIMEZONE = "UTC";
    const utc = localeCacheDimension("en-US");
    process.env.RUN_TIMEZONE = "Asia/Kolkata";
    expect(localeCacheDimension("en-US")).not.toBe(utc);
  });

  it("is 'system' when pinning is off — a distinct key, not a collision with en-US", () => {
    process.env.RUN_LOCALE = "";
    expect(localeCacheDimension()).toBe("system");
    delete process.env.RUN_LOCALE;
    expect(localeCacheDimension()).not.toBe("system");
  });

  it("is stable for the same inputs, so it does not defeat the cache it keys", () => {
    expect(localeCacheDimension("en-US")).toBe(localeCacheDimension("en-US"));
  });
});

describe("specLocaleEnv — what crosses into the Playwright child", () => {
  it("hands the resolved pair to the child", () => {
    process.env.RUN_LOCALE = "de-DE";
    process.env.RUN_TIMEZONE = "Europe/Berlin";
    expect(specLocaleEnv()).toEqual({ RUN_LOCALE: "de-DE", RUN_TIMEZONE: "Europe/Berlin" });
  });

  it("resolves the default rather than passing nothing when the var is unset", () => {
    // The child inherits process.env, so an unset RUN_LOCALE would leave it to default on its own.
    // It must default to the same thing the pipeline did, not independently.
    expect(specLocaleEnv()).toEqual({ RUN_LOCALE: "en-US", RUN_TIMEZONE: "UTC" });
  });

  it("writes NOTHING when pinning is off, leaving an inherited RUN_LOCALE='' intact", () => {
    process.env.RUN_LOCALE = "";
    expect(specLocaleEnv()).toEqual({});
  });

  it("carries the ambient run locale, not just the env var", () => {
    // This is the whole point of resolving in the parent: a per-run locale has no env var to be
    // read from, and the child has no AsyncLocalStorage to read.
    withRunLocale("ko-KR", () => {
      expect(specLocaleEnv()).toMatchObject({ RUN_LOCALE: "ko-KR" });
    });
  });
});

describe("the request allow-list", () => {
  it("accepts every tag it advertises", () => {
    for (const tag of SUPPORTED_RUN_LOCALES) expect(isSupportedRunLocale(tag)).toBe(true);
  });

  it("rejects anything else, including non-strings", () => {
    for (const bad of ["en_US", "en", "xx-XX", "", " en-US", 5, null, undefined, {}, ["en-US"]]) {
      expect(isSupportedRunLocale(bad), `${JSON.stringify(bad)} must not pass`).toBe(false);
    }
  });

  it("every advertised tag actually resolves to itself through the helper", () => {
    // A tag in the allow-list that the helper mangled would be a route accepting something the
    // browser then never receives.
    for (const tag of SUPPORTED_RUN_LOCALES) {
      expect(browserContextOptions(tag)).toMatchObject({ locale: tag });
    }
  });
});
