import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { scrubServedSecrets } from "../src/stages/executor.js";

// Regression: results.json, final-page.txt, and error-context attachments are all served
// publicly under /runs, and a page a secret-credential run is logged into routinely echoes
// the identifier back ("Signed in as you@example.com"). The generated spec already never
// writes the literal secret (env-var reference instead), but these three sinks were never
// scrubbed of it either — until scrubServedSecrets.
describe("scrubServedSecrets", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("redacts the secret from raw, final-page.txt, and error-context files", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "scrub-test-"));
    const artifactsDir = path.join(dir, "artifacts");
    const resultsJson = path.join(dir, "results.json");
    const finalPage = path.join(artifactsDir, "final-page.txt");
    const errorCtx = path.join(artifactsDir, "error-context.md");
    mkdirSync(artifactsDir, { recursive: true });

    const secretEnv = { TEST_USERNAME: "lakshya.soni@thinkvibes.com", TEST_PASSWORD: "hunter22" };
    const raw = { message: "Signed in as lakshya.soni@thinkvibes.com" };
    writeFileSync(resultsJson, JSON.stringify(raw), "utf8");
    writeFileSync(finalPage, "https://example.com/account\nSigned in as lakshya.soni@thinkvibes.com", "utf8");
    writeFileSync(errorCtx, "user: lakshya.soni@thinkvibes.com", "utf8");

    const out = scrubServedSecrets(raw, artifactsDir, resultsJson, [errorCtx], secretEnv);

    expect(JSON.stringify(out)).not.toContain("lakshya.soni@thinkvibes.com");
    expect(readFileSync(resultsJson, "utf8")).not.toContain("lakshya.soni@thinkvibes.com");
    expect(readFileSync(finalPage, "utf8")).not.toContain("lakshya.soni@thinkvibes.com");
    expect(readFileSync(errorCtx, "utf8")).not.toContain("lakshya.soni@thinkvibes.com");
  });

  it("is a no-op when secretEnv carries no credentials (public demo run)", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "scrub-test-"));
    const artifactsDir = path.join(dir, "artifacts");
    const resultsJson = path.join(dir, "results.json");
    mkdirSync(artifactsDir, { recursive: true });
    const raw = { message: "Signed in as standard_user" };
    writeFileSync(resultsJson, JSON.stringify(raw), "utf8");

    const out = scrubServedSecrets(raw, artifactsDir, resultsJson, [], {});
    expect(out).toEqual(raw);
    expect(readFileSync(resultsJson, "utf8")).toBe(JSON.stringify(raw));
  });
});
