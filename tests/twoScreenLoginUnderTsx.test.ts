import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The two-screen login, run under tsx — the transform the real server uses — in a child process.
 *
 * TD-40, CLAUDE.md "sharp edges": a named function inside a `page.evaluate` callback becomes a
 * `__name(...)` call under esbuild/tsx, and `__name` does not exist in the browser. vitest does not
 * inject that helper, so tests/twoScreenLogin.test.ts and tests/salesforceLogin.test.ts would pass
 * with the bug present. This one would not: it fails with the ReferenceError the server would hit.
 * The script it runs is tests/fixtures/loginUnderTsx.ts.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("two-screen login under tsx (TD-40)", () => {
  it("every new page.evaluate runs under the server's own transform", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "tests/fixtures/loginUnderTsx.ts"], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000,
    });
    const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
    expect(line, `no result line; stderr:\n${run.stderr}`).toBeTruthy();
    const out = JSON.parse(line!.slice("RESULT ".length));
    expect(out.error, "the script threw").toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("__name");
    expect(out.gate, "identifier-first detection").toBe(true);
    expect(out.check, "two screens + the authenticator code screen").toMatchObject({ ok: true, landedUrl: "http://app.test/home" });
  }, 150_000);
});
