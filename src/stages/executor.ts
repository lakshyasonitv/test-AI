import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface ExecResult {
  passed: boolean;
  exitCode: number;
  resultsJsonPath: string;
  artifactsDir: string;
  raw: any | null;
  screenshot?: string;
  accessibilitySnapshot?: string;
  currentUrl?: string;
}

// Configuration
const CONFIG = {
  TIMEOUTS: {
    TEST_RUN: 60_000, // Increased from 30s to 60s
    ELEMENT_WAIT: 10_000,
    RETRY_DELAY: 2_000,
  },
  RETRIES: 2, // Number of retry attempts for flaky tests
};

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runSpec(
  specCode: string, runDir: string, secretEnv: Record<string, string> = {}
): Promise<ExecResult> {
  console.log("[executor] runSpec() called, runDir:", runDir);
  const genDir = path.join(runDir, "generated");
  mkdirSync(genDir, { recursive: true });
  const specPath = path.join(genDir, "test.spec.ts");
  writeFileSync(specPath, specCode, "utf8");

  const resultsJson = path.join(runDir, "results.json");
  const artifactsDir = path.join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  const cliPath = path.join(process.cwd(), "node_modules", "@playwright", "test", "cli.js");
  const specArg = specPath.replace(/\\/g, "/");
  console.log("[executor] cliPath:", cliPath, "| exists:", existsSync(cliPath));
  console.log("[executor] specArg:", specArg);

  // Retry only what is worth retrying.
  //
  // This loop previously returned on `exitCode === 1`, and Playwright exits 1 for ANY test
  // failure — so the retry never once ran for a real test, only for spawn/crash errors.
  // Re-running a genuine assertion failure is also the wrong thing to do: it doubles the
  // wall-clock cost of every failing run and can mask a real defect as "flaky". So: retry
  // infrastructure failures (Playwright itself failed to run), report test failures once.
  let lastError: any;

  for (let attempt = 1; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      const result = await executePlaywright(specPath, resultsJson, artifactsDir, cliPath, secretEnv);

      // exitCode 1 with a parsed report = Playwright ran and the test has a verdict.
      // That verdict is the answer, pass or fail.
      if (result.passed || result.raw) return result;

      // No report at all: Playwright didn't get far enough to produce one (bad spawn,
      // missing browser, killed by the safety timeout). That is worth another go.
      if (attempt === CONFIG.RETRIES) return result;
      console.log(`[executor] no report produced — retrying (${attempt + 1}/${CONFIG.RETRIES})`);
      await sleep(CONFIG.TIMEOUTS.RETRY_DELAY);
    } catch (error) {
      lastError = error;
      if (attempt === CONFIG.RETRIES) break;
      console.log(`[executor] run threw — retrying (${attempt + 1}/${CONFIG.RETRIES}): ${(error as any)?.message ?? error}`);
      await sleep(CONFIG.TIMEOUTS.RETRY_DELAY);
    }
  }

  throw lastError || new Error("Playwright produced no result after retries");
}

async function executePlaywright(
  specPath: string,
  resultsJson: string,
  artifactsDir: string,
  cliPath: string,
  /** Credentials the user supplied for their own site. Passed to the child process only —
   *  the spec on disk holds a `process.env.X` reference, never the value. Deliberately not
   *  logged anywhere in this file. */
  secretEnv: Record<string, string> = {}
): Promise<ExecResult> {
  const exitCode: number = await new Promise((resolve) => {
    console.log("[executor] Spawning Playwright...");
    const p = spawn(
      process.execPath,
      [cliPath, "test", specPath.replace(/\\/g, "/"), "--reporter=json", `--output=${artifactsDir}`],
      {
        env: {
          ...process.env,
          ...secretEnv,
          PLAYWRIGHT_JSON_OUTPUT_NAME: resultsJson,
          PLAYWRIGHT_HEADLESS: 'true',
          PLAYWRIGHT_TIMEOUT: String(CONFIG.TIMEOUTS.TEST_RUN),
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    console.log("[executor] Spawned pid =", p.pid);

    p.on("spawn", () => console.log("[executor] event: spawn"));
    p.on("exit", (code) => console.log("[executor] event: exit", code));
    p.on("disconnect", () => console.log("[executor] event: disconnect"));
    p.on("error", (err) => {
      console.error("[executor] event: error", err.message);
      resolve(1);
    });
    p.on("close", (code) => {
      console.log("[executor] event: close", code);
      if (!existsSync(resultsJson) && out.trim().startsWith("{")) {
        writeFileSync(resultsJson, out, "utf8");
      }
      resolve(code ?? 1);
    });

    let out = "";
    p.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      console.log("[PW STDOUT]", s);
    });
    p.stderr.on("data", (d) => {
      console.log("[PW STDERR]", d.toString());
    });

    // Safety timeout: kill Playwright if it runs longer than configured timeout
    const timeout = setTimeout(() => {
      console.error(`[executor] TIMEOUT ${CONFIG.TIMEOUTS.TEST_RUN / 1000}s — killing Playwright (pid=${p.pid})`);
      p.kill("SIGKILL");
      resolve(1);
    }, CONFIG.TIMEOUTS.TEST_RUN);
    p.on("close", () => clearTimeout(timeout));
  });

  let raw: any = null;
  try { raw = JSON.parse(readFileSync(resultsJson, "utf8")); } catch { /* leave null */ }

  console.log("[executor] Results parsed:", raw ? "yes" : "no", "| exitCode:", exitCode);

  let screenshot: string | undefined;
  let accessibilitySnapshot: string | undefined;

  if (raw) {
    for (const suite of raw.suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const testObj of spec.tests ?? []) {
          for (const res of testObj.results ?? []) {
            for (const attach of res.attachments ?? []) {
              if (attach.name === "screenshot") {
                screenshot = attach.path;
              } else if (attach.name === "error-context") {
                try {
                  const content = readFileSync(attach.path, "utf8");
                  const match = content.match(/```yaml\n([\s\S]*?)\n```/);
                  if (match) {
                    accessibilitySnapshot = match[1];
                  }
                } catch {
                  // ignore
                }
              }
            }
          }
        }
      }
    }
  }

  console.log("[executor] runSpec() returning, passed:", exitCode === 0);
  return {
    passed: exitCode === 0,
    exitCode,
    resultsJsonPath: resultsJson,
    artifactsDir,
    raw,
    screenshot,
    accessibilitySnapshot
  };
}

/** Best-effort: find a screenshot in the artifacts tree (for Failure Analysis vision). */
export function findScreenshot(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.png$/i.test(entry.name)) return full;
    }
  }
  return null;
}
