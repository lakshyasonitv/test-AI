import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDER_ENV_VARS,
  findInvalidProviderEnv,
  formatInvalidProviderEnv,
} from "../src/server/index.js";

/**
 * The boot guard that refuses an LLM provider variable set to anything but exactly
 * "gemini"/"azure".
 *
 * Why it exists: `resolvedProvider()` in llmContext.ts reads `LLM_PROVIDER ?? "gemini"`, so a
 * typo like `LLM_PROVIDER=azureEE` would be silently coerced to the default and the whole
 * pipeline would keep paying Google while the operator believes Azure is live — expensive on
 * every dimenstion (endpoint, tenancy, billing) and invisible. A present value must be exact.
 *
 * `findInvalidProviderEnv` is pure and takes its environment as an argument, mirroring
 * `findInvalidBooleanFlags`, so these tests never touch `process.env` or boot a server. The
 * `process.exit(1)` it feeds lives inside `isMain`, which importing `app` does not trigger.
 */
describe("LLM provider env boot guard", () => {
  describe("one test per variable: a malformed value is rejected and named", () => {
    for (const name of LLM_PROVIDER_ENV_VARS) {
      it(`rejects ${name} set to a non-provider value`, () => {
        const bad = findInvalidProviderEnv({ [name]: "azureEE" });
        expect(bad).toEqual([{ name, found: "azureEE" }]);
        const msg = formatInvalidProviderEnv(bad);
        expect(msg).toContain(name);
        expect(msg).toContain("azureEE");
      });
    }
  });

  describe("one test per variable: both providers are accepted", () => {
    for (const name of LLM_PROVIDER_ENV_VARS) {
      it(`accepts ${name}="gemini" and ${name}="azure"`, () => {
        expect(findInvalidProviderEnv({ [name]: "gemini" })).toEqual([]);
        expect(findInvalidProviderEnv({ [name]: "azure" })).toEqual([]);
      });
    }
  });

  describe("the values that look deliberate but are not a provider", () => {
    it("rejects a present-but-empty value", () => {
      expect(findInvalidProviderEnv({ LLM_PROVIDER: "" })).toEqual([
        { name: "LLM_PROVIDER", found: "" },
      ]);
    });

    it("shows an empty value visibly in the message rather than as blank space", () => {
      const msg = formatInvalidProviderEnv(findInvalidProviderEnv({ LLM_PROVIDER: "" }));
      expect(msg).toContain('LLM_PROVIDER=""');
    });

    it.each(["Azure", "AZURE", "Gemini", "1", "yes", " azure", "azure "])(
      "rejects %j rather than coercing it",
      (value) => {
        expect(findInvalidProviderEnv({ LLM_PROVIDER: value })).toEqual([
          { name: "LLM_PROVIDER", found: value },
        ]);
      },
    );
  });

  describe("absent is not an error", () => {
    it("ignores a variable that is not set at all", () => {
      expect(findInvalidProviderEnv({})).toEqual([]);
    });

    it("ignores an explicitly-undefined variable", () => {
      expect(findInvalidProviderEnv({ LLM_PROVIDER: undefined })).toEqual([]);
    });

    it("does not confuse absent with present-but-empty", () => {
      expect(findInvalidProviderEnv({ LLM_PROVIDER: undefined })).toEqual([]);
      expect(findInvalidProviderEnv({ LLM_PROVIDER: "" })).toHaveLength(1);
    });
  });

  describe("reporting", () => {
    it("reports every malformed variable at once, not just the first", () => {
      const bad = findInvalidProviderEnv({
        LLM_PROVIDER: "azureEE",
        LLM_PROVIDER_LITE: "gemini",
        PORT: "3000",
      });
      expect(bad.map((b) => b.name)).toEqual(["LLM_PROVIDER"]);
      const msg = formatInvalidProviderEnv(bad);
      expect(msg).toContain("LLM_PROVIDER");
      expect(msg).not.toContain("LLM_PROVIDER_LITE");
    });

    it("ignores env vars that are not provider selectors", () => {
      expect(findInvalidProviderEnv({
        PORT: "3000", GEMINI_MODEL: "gemini-2.5-pro", AZURE_OPENAI_DEPLOYMENT: "my-deploy",
      })).toEqual([]);
    });
  });

  describe("the declared list stays in step with the code", () => {
    it("declares exactly the two provider selectors", () => {
      expect([...LLM_PROVIDER_ENV_VARS].sort()).toEqual(["LLM_PROVIDER", "LLM_PROVIDER_LITE"]);
    });

    it("declares no duplicates", () => {
      expect(new Set(LLM_PROVIDER_ENV_VARS).size).toBe(LLM_PROVIDER_ENV_VARS.length);
    });
  });
});