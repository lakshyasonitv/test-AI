import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { scrubServedSecrets } from "../src/stages/executor.js";
import { REDACTED } from "../src/stages/credentials.js";

const dir = path.join("runs", "scrub-test");

function fresh(): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("scrubServedSecrets", () => {
  const secretEnv = { TEST_USERNAME: "me@real.com", TEST_PASSWORD: "hunter2" };

  it("redacts secrets from the returned raw report and from results.json on disk", () => {
    fresh();
    const resultsJson = path.join(dir, "results.json");
    const raw = { config: {}, suites: [{ error: "expected 'hunter2' but got nothing; signed in as me@real.com" }] };
    writeFileSync(resultsJson, JSON.stringify(raw), "utf8");

    const out = scrubServedSecrets(raw, dir, resultsJson, [], secretEnv);

    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).not.toContain("me@real.com");
    expect(JSON.stringify(out)).toContain(REDACTED);
    const onDisk = readFileSync(resultsJson, "utf8");
    expect(onDisk).not.toContain("hunter2");
    expect(onDisk).toContain(REDACTED);
  });

  it("scrubs final-page.txt and error-context attachment files", () => {
    fresh();
    const resultsJson = path.join(dir, "results.json");
    const finalPage = path.join(dir, "final-page.txt");
    const errorContext = path.join(dir, "error-context.txt");
    writeFileSync(resultsJson, "{}", "utf8");
    writeFileSync(finalPage, "https://app.test/dashboard\nWelcome, me@real.com", "utf8");
    writeFileSync(errorContext, "snapshot:\n  text: Signed in as me@real.com", "utf8");

    scrubServedSecrets({}, dir, resultsJson, [errorContext], secretEnv);

    expect(readFileSync(finalPage, "utf8")).not.toContain("me@real.com");
    expect(readFileSync(errorContext, "utf8")).not.toContain("me@real.com");
  });

  it("leaves output untouched for non-secret (public demo) credentials", () => {
    fresh();
    const resultsJson = path.join(dir, "results.json");
    const finalPage = path.join(dir, "final-page.txt");
    const body = "Welcome, demo_user";
    writeFileSync(resultsJson, JSON.stringify({ msg: body }), "utf8");
    writeFileSync(finalPage, body, "utf8");

    const out = scrubServedSecrets({ msg: body }, dir, resultsJson, [], {});

    expect(out.msg).toBe(body);
    expect(readFileSync(resultsJson, "utf8")).toContain(body);
    expect(readFileSync(finalPage, "utf8")).toBe(body);
  });
});
