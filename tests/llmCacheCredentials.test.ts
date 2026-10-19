import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { llmCacheSet, llmCacheGet, makeCacheKey, cacheNamespaceDir } from "../src/kb/llmCache.js";
import { cacheGet, cacheSet } from "../src/kb/cache.js";
import { rememberRunSecrets } from "../src/runSecrets.js";
import { withRunId } from "../src/runContext.js";

// TD-156, the open half: the LLM disk cache stored each model answer exactly as returned. SauceDemo
// prints its demo password on the login page, the case writer copied it into step text ("Type
// '<password>' into the 'Password' field"), and that answer went to runs/_cache/llm on most runs.
// The run's credential VALUES must never reach a cache: not the stored body, not the key input. They
// become the same `${env:...}` references the generated spec already uses, so a cached answer still
// means "type this run's password" when it is served again.

const NS = "llm-test-td156"; // own namespace, removed afterwards; never clears a shared one
const RUN = "test-run-td156-cache";
const USER = "canary_user_5d2e";
const PASS = "canary_pass_8f1b";

afterAll(() => { rmSync(cacheNamespaceDir(NS), { recursive: true, force: true }); });

describe("TD-156: no credential value reaches a cache", () => {
  it("the stored body on disk has the env reference, not the value", () => {
    withRunId(RUN, () => {
      rememberRunSecrets(RUN, { username: USER, password: PASS, secret: true });
      const key = makeCacheKey("cases", String(Math.random()));
      llmCacheSet(key, [{ title: "Locked out", steps: [`Type '${USER}' and '${PASS}' into the form.`] }], NS);
      const onDisk = readFileSync(path.join(cacheNamespaceDir(NS), key + ".json"), "utf8");
      expect(onDisk.includes(PASS)).toBe(false);
      expect(onDisk.includes(USER)).toBe(false);
      expect(onDisk).toContain("${env:TEST_PASSWORD}");
      expect(onDisk).toContain("${env:TEST_USERNAME}");
      // The in-memory copy is the same safe value.
      expect(JSON.stringify(llmCacheGet(key, NS))).not.toContain(PASS);
    });
  });

  it("the key input is redacted too: a prompt carrying the value keys like one carrying the reference", () => {
    withRunId(RUN, () => {
      rememberRunSecrets(RUN, { username: USER, password: PASS, secret: true });
      expect(makeCacheKey(`log in with ${PASS}`)).toBe(makeCacheKey("log in with ${env:TEST_PASSWORD}"));
    });
  });

  it("the app-model cache (discovery) is redacted the same way", () => {
    withRunId(RUN, () => {
      rememberRunSecrets(RUN, { username: USER, password: PASS, secret: true });
      const url = `https://td156.example/login?probe=${Math.random()}`;
      cacheSet(url, { baseUrl: "https://td156.example", pages: [{ url, title: "Login", concepts: [], elements: [],
        markdown: `Password for all users: ${PASS}` }] } as any);
      const served = cacheGet(url)!;
      expect(JSON.stringify(served)).not.toContain(PASS);
      const file = path.join("runs", "_cache", "appmodels");
      if (existsSync(file)) {
        for (const f of require("node:fs").readdirSync(file)) {
          const p = path.join(file, f);
          const body = readFileSync(p, "utf8");
          if (!body.includes("td156.example")) continue;
          rmSync(p, { force: true }); // our own probe entry only, removed before asserting
          expect(body.includes(PASS)).toBe(false);
        }
      }
    });
  });

  it("outside any run with credentials, nothing changes", () => {
    const key = makeCacheKey("plain", String(Math.random()));
    llmCacheSet(key, { text: "no secrets here" }, NS);
    expect(llmCacheGet(key, NS)).toEqual({ text: "no secrets here" });
  });
});
