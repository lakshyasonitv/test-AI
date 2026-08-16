import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { redactCredentials, type Credentials } from "./credentials.js";

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
    // This is a hard backstop, not the real per-test budget — Playwright's OWN per-test
    // timeout (playwright.config.ts, currently 50s) is what should end a hung test and let its
    // JSON reporter's onEnd() write results.json. This value only needs to be comfortably
    // ABOVE that, with enough slack for trace/video finalization on a failing test (observed
    // 7-20MB of trace resources to zip) plus cold-start overhead. It previously sat at 60s —
    // barely 10s above Playwright's own 50s timeout, no finalization slack at all — and two
    // real runs (see TECH_DEBT.md TD-02) measured this SIGKILLing the child before it could
    // write a report, on BOTH the initial attempt and its retry, so the failure diagnosis that
    // follows had no error text to work from and guessed the wrong step every time.
    TEST_RUN: 100_000,
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

/**
 * Build a Credentials object from the env vars handed to the child process, so the same
 * redactCredentials scrub (same values, same REDACTED token) applies to executor output.
 * undefined for non-secret runs — scrubbing the public demo accounts would be pointless.
 */
function secretCreds(secretEnv: Record<string, string>): Credentials | undefined {
  const username = secretEnv.TEST_USERNAME;
  const password = secretEnv.TEST_PASSWORD;
  if (!username && !password) return undefined;
  return { username: username ?? "", password: password ?? "", secret: true };
}

/**
 * The spec's afterEach writes the visible page text (final-page.txt), Playwright writes the
 * failure error-context attachment, and results.json embeds both — and a page the user is
 * logged into routinely echoes the identifier ("Signed in as you@example.com"). All of these
 * are served to the browser under /runs, so scrub the secret values out of every one of them.
 * Best-effort: never fail a run over its own cleanup.
 */
export function scrubServedSecrets(raw: any, artifactsDir: string, resultsJson: string, errorContextFiles: string[], secretEnv: Record<string, string>): any {
  const creds = secretCreds(secretEnv);
  if (!creds) return raw;
  let out = raw;
  try {
    if (raw) {
      out = redactCredentials(raw, creds);
      writeFileSync(resultsJson, JSON.stringify(out, null, 2), "utf8");
    }
  } catch { /* keep the unscrubbed raw */ }
  for (const f of [path.join(artifactsDir, "final-page.txt"), ...errorContextFiles]) {
    try {
      if (existsSync(f)) writeFileSync(f, redactCredentials(readFileSync(f, "utf8"), creds), "utf8");
    } catch { /* best effort */ }
  }
  return out;
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
  const errorContextFiles: string[] = [];

  if (raw) {
    for (const suite of raw.suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const testObj of spec.tests ?? []) {
          for (const res of testObj.results ?? []) {
            for (const attach of res.attachments ?? []) {
              if (attach.name === "screenshot") {
                screenshot = attach.path;
              } else if (attach.name === "error-context") {
                errorContextFiles.push(attach.path);
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
    raw: scrubServedSecrets(raw, artifactsDir, resultsJson, errorContextFiles, secretEnv),
    screenshot,
    accessibilitySnapshot
  };
}

/** Best-effort: find a screenshot in the artifacts tree (for Failure Analysis vision). */
/**
 * Things an automated test cannot get past, no matter how well written: a verification code
 * emailed to a human, an SMS one-time code, a CAPTCHA. A run that ends on one of these has not
 * passed and has not found a bug — it has hit a wall, and saying so with a screenshot is the
 * only honest report.
 *
 * Deliberately does NOT include "continue with google": that button sits on the login page
 * itself, so matching it against final page text would mark every ordinary login case blocked.
 * OAuth counts only when the flow actually left the app's origin, which is checked separately.
 */
const VERIFICATION_GATE =
  /check your email|verification code|verify your email|6[- ]digit|one[- ]time (code|password)|\bOTP\b|enter the code|captcha|recaptcha/i;

export interface BlockedInfo {
  /** Plain-English reason, for the UI. */
  reason: string;
  /** The step screenshot showing the wall — the proof. */
  screenshot: string | null;
}

/**
 * Did this test end somewhere automation cannot continue from? Reads the `final-page.txt` the
 * generated spec writes in its afterEach hook (url on the first line, visible text after).
 * Returns null when nothing blocked it, which is the normal case.
 */
export function detectBlocked(artifactsDir: string, appOrigin?: string): BlockedInfo | null {
  const f = path.join(artifactsDir, "final-page.txt");
  if (!existsSync(f)) return null;
  let body = "";
  try { body = readFileSync(f, "utf8"); } catch { return null; }
  const [finalUrl = "", ...rest] = body.split("\n");
  const text = rest.join("\n");

  let reason: string | null = null;
  if (VERIFICATION_GATE.test(text)) {
    reason = "the flow reached a verification step that needs a code sent to a real inbox or phone, " +
      "which an automated test can't read";
  } else if (appOrigin && finalUrl && !finalUrl.startsWith(appOrigin)) {
    try {
      reason = `the flow left the application for ${new URL(finalUrl).host}, an external sign-in ` +
        `provider the test can't complete`;
    } catch { /* unparseable url — not a reliable signal, fall through */ }
  }
  if (!reason) return null;

  // Prefer the LAST step screenshot: that's the frame showing the wall itself.
  const shots = existsSync(artifactsDir)
    ? readdirSync(artifactsDir).filter(n => /^step-\d+\.png$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    : [];
  const screenshot = shots.length ? path.join(artifactsDir, shots[shots.length - 1]) : findScreenshot(artifactsDir);
  return { reason, screenshot };
}

/**
 * The representative screenshot for a case. Prefers the LAST step-N.png (the frame closest
 * to whatever the case actually verified — e.g. the destination page after a navigation, not
 * the pre-action homepage) over a blind "first .png found" walk, which always landed on
 * step-1.png and showed the same generic pre-action frame for every case in a run regardless
 * of what it tested. Falls back to the original DFS-first-found walk only when this directory
 * has no numbered step screenshots at all (a case that crashed before its first shot() call,
 * or a subdirectory holding only Playwright's own attachment).
 */
export function findScreenshot(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const steps = readdirSync(dir)
    .filter(n => /^step-\d+\.png$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (steps.length) return path.join(dir, steps[steps.length - 1]);

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

/**
 * Find a case's recorded video, if one exists. Mirrors findScreenshot's recursive-walk
 * fallback exactly — videos live nested under a Playwright-generated test-output subfolder
 * (e.g. `artifacts/<test-name-hash>/video.webm`), never at a predictable top-level name the
 * way `step-N.png` is, so there's no fast-path equivalent to check first.
 *
 * playwright.config.ts sets `video: "retain-on-failure"` — a video only exists for a case that
 * actually failed or was blocked (deliberate: a full trace per PASSING run made up ~80% of the
 * runs/ folder's size for no diagnostic value, see that config's own comment). A passed case
 * naturally returns null here, no separate status check needed.
 */
export function findVideo(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.webm$/i.test(entry.name)) return full;
    }
  }
  return null;
}
