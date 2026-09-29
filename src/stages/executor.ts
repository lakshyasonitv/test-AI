import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { redactCredentials, type Credentials } from "./credentials.js";
import { siteHost } from "../text.js";

export interface ExecResult {
  passed: boolean;
  exitCode: number;
  resultsJsonPath: string;
  artifactsDir: string;
  raw: any | null;
  screenshot?: string;
  accessibilitySnapshot?: string;
  currentUrl?: string;
  /**
   * Set only when video recording had to be turned off for this run. Additive and optional:
   * every existing reader of an ExecResult is unaffected when it is absent, which is always
   * unless ffmpeg is missing.
   */
  videoUnavailable?: string;
}

/**
 * Is Playwright's bundled ffmpeg actually on disk?
 *
 * WHY THIS EXISTS. `playwright.config.ts` records video, and Playwright starts the recorder when
 * the CONTEXT is created — so a missing ffmpeg does not degrade to "no video", it stops the
 * context opening at all:
 *
 *     browserContext.newPage: Executable doesn't exist at …\ms-playwright\ffmpeg-1010\ffmpeg-win64.exe
 *
 * Every case in run `2026-08-31T06-56-52-852Z-7943ebb2` died that way, ~960 ms in, before a single
 * `page.goto`. `screenshot: "on"` then photographed a page that had never navigated, so the UI
 * showed a blank white 4,331-byte PNG and reported a test failure. Nothing about the site under
 * test was wrong. See `TECH_DEBT.md` TD-71.
 *
 * HOW IT PROBES. By looking for the binary, not by asking Playwright: the registry that owns this
 * path is `playwright-core` internals, and reaching into it would couple a shipped code path to a
 * private module across version bumps. The layout is stable and public — `<browsers>/ffmpeg-<rev>/`
 * containing a file whose name starts with `ffmpeg` — so a glob over it is both simpler and less
 * likely to break than the "correct" API.
 *
 * Deliberately permissive: an unreadable browsers directory returns `true`. The cost of a false
 * negative is turning video off for a run that could have had it; the cost of a false positive is
 * nothing, because the run then behaves exactly as it does today.
 */
let ffmpegProbe: { ok: boolean; searched: string } | null = null;

export function ffmpegAvailable(): { ok: boolean; searched: string } {
  if (ffmpegProbe) return ffmpegProbe;

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "ms-playwright")
      : process.platform === "darwin"
        ? path.join(home, "Library", "Caches", "ms-playwright")
        : path.join(home, ".cache", "ms-playwright"));

  let ok = true;
  try {
    if (existsSync(browsers)) {
      const dirs = readdirSync(browsers).filter((n) => /^ffmpeg[-_]/i.test(n));
      // A truncated download leaves the directory in place with a short or absent binary, which
      // is how this failed in practice — the folder existing is not the question, the file is.
      ok = dirs.some((d) => {
        try { return readdirSync(path.join(browsers, d)).some((f) => /^ffmpeg/i.test(f)); }
        catch { return false; }
      });
    }
  } catch { ok = true; }

  ffmpegProbe = { ok, searched: browsers };
  return ffmpegProbe;
}

/** Test seam — the probe is memoized so a real run globs the disk once per process. */
export function resetFfmpegProbe(): void { ffmpegProbe = null; }

/** One line, naming the command that fixes it. Called once at server startup. */
export function warnIfNoVideo(): void {
  const { ok, searched } = ffmpegAvailable();
  if (ok) return;
  console.warn(
    `[executor] Playwright's ffmpeg is missing from ${searched} — video recording is OFF for ` +
    `every run until it is installed. Tests still run and still pass or fail normally.\n` +
    `[executor] Fix with:  npx playwright install\n` +
    `[executor] If that hangs, check for a stale __dirlock and a leftover ` +
    `oopDownloadBrowserMain.js process before retrying.`,
  );
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

/** Slack between Playwright's own per-test timeout and the SIGKILL above it — the 100s/50s gap
 *  TD-02 settled on, kept as a difference so it survives the per-test budget changing. */
const KILL_SLACK_MS = CONFIG.TIMEOUTS.TEST_RUN - 50_000;

/**
 * The per-test budget for THIS spec, scaled by how many steps it carries.
 *
 * A 3-step case and a 25-step case both used to get 50s for the whole `test()`. A long case can
 * exhaust that purely by having more steps, with every individual step healthy — and it surfaces
 * as `Test timeout of 50000ms exceeded`, which this file already notes is the CONSEQUENCE of the
 * first error rather than a second failure.
 *
 * Counted from the spec text rather than the IR: `generateSpec` emits exactly one `test.step()`
 * per IR step, so the count is already here and `runSpec`'s signature does not have to change.
 *
 * `PLAYWRIGHT_TIMEOUT` set explicitly wins outright — that is what "configurable" has to mean, and
 * `playwright.config.ts` has read it since TD-24. Unset, the budget is the old 50s floor or the
 * per-step allowance, whichever is larger, so short cases behave exactly as before.
 */
export function perTestTimeoutMs(specCode: string): number {
  const explicit = Number(process.env.PLAYWRIGHT_TIMEOUT);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const steps = (specCode.match(/test\.step\(/g) ?? []).length;
  const perStep = Number(process.env.PLAYWRIGHT_STEP_BUDGET_MS) || 6_000;
  return Math.max(50_000, steps * perStep);
}

/**
 * The SIGKILL backstop, derived from the per-test budget rather than fixed.
 *
 * It exists to sit comfortably ABOVE Playwright's own timeout so the JSON reporter's onEnd() can
 * still write results.json — TD-02 measured a too-tight gap SIGKILLing the child on both the
 * attempt and its retry, leaving the diagnosis with no error text and guessing the wrong step
 * every time. Hardcoding 100s while the per-test budget scales would reintroduce exactly that on
 * any case long enough to pass it.
 */
export function killTimeoutMs(specCode: string): number {
  return perTestTimeoutMs(specCode) + KILL_SLACK_MS;
}

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
      const result = await executePlaywright(specPath, resultsJson, artifactsDir, cliPath, perTestTimeoutMs(specCode), secretEnv);

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
  /** This spec's per-test budget, from `perTestTimeoutMs`. Passed in rather than recomputed here
   *  because the spec TEXT (which the step count comes from) lives in the caller. */
  perTestMs: number,
  /** Credentials the user supplied for their own site. Passed to the child process only —
   *  the spec on disk holds a `process.env.X` reference, never the value. Deliberately not
   *  logged anywhere in this file. */
  secretEnv: Record<string, string> = {}
): Promise<ExecResult> {
  const exitCode: number = await new Promise((resolve) => {
    console.log("[executor] Spawning Playwright...");
    // One probe per process (memoized). Decides whether this child records video at all.
    const video = ffmpegAvailable();

    const p = spawn(
      process.execPath,
      [cliPath, "test", specPath.replace(/\\/g, "/"), "--reporter=json", `--output=${artifactsDir}`],
      {
        env: {
          ...process.env,
          ...secretEnv,
          PLAYWRIGHT_JSON_OUTPUT_NAME: resultsJson,
          PLAYWRIGHT_HEADLESS: 'true',
          // Read by playwright.config.ts (since TD-24). Set per run so a long case gets a budget
          // proportional to its step count instead of every case sharing one 50s ceiling. An
          // explicitly-set PLAYWRIGHT_TIMEOUT passes straight through — see perTestTimeoutMs.
          PLAYWRIGHT_TIMEOUT: String(perTestMs),
          // Read by playwright.config.ts. Missing ffmpeg does not degrade video to "off" on its
          // own — it stops browserContext.newPage() outright, failing a valid case before it
          // navigates (TD-71). Turning recording off is what keeps the run runnable.
          ...(video.ok ? {} : { PLAYWRIGHT_VIDEO: 'off' }),
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

    // Safety timeout: kill Playwright if it outlives its own per-test budget plus finalization
    // slack. Derived per spec rather than fixed, so it stays above the budget as that scales.
    const killMs = perTestMs + KILL_SLACK_MS;
    const timeout = setTimeout(() => {
      console.error(`[executor] TIMEOUT ${killMs / 1000}s — killing Playwright (pid=${p.pid})`);
      p.kill("SIGKILL");
      resolve(1);
    }, killMs);
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
  const video = ffmpegAvailable();
  return {
    passed: exitCode === 0,
    exitCode,
    resultsJsonPath: resultsJson,
    artifactsDir,
    raw: scrubServedSecrets(raw, artifactsDir, resultsJson, errorContextFiles, secretEnv),
    screenshot,
    accessibilitySnapshot,
    // Present only when recording was suppressed, so the UI can say "video unavailable" rather
    // than silently showing no player — and above all so this is never again mistaken for a
    // test failure (TD-71).
    ...(video.ok ? {} : {
      videoUnavailable:
        "Video was not recorded: Playwright's ffmpeg is not installed. Run `npx playwright install`. "
        + "The test itself ran normally — this does not affect the result.",
    }),
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
 * Are these two URLs the same site, for the purpose of "did the flow leave the application?"
 *
 * Compares HOSTS, not origin string prefixes. The previous check was
 * `!finalUrl.startsWith(appOrigin)`, which treats a scheme change as leaving the app: a user
 * entered `http://veterans.my.site.com/s/`, the site redirected to `https://…`, and all three
 * correct cases in run `2026-09-01T07-17-37-947Z-35c773cf` were reported as
 * "the flow left the application for veterans.my.site.com, an external sign-in provider" —
 * naming the app's own host as the external provider. `TECH_DEBT.md` TD-69.
 *
 * Scheme and port are irrelevant to "is this still the app", and a leading `www.` is the same
 * site by universal convention, so both are ignored.
 *
 * **Unreadable input returns `true` (same site).** This guard exists to catch a flow leaving for
 * an external provider; being wrong in that direction marks passing tests as blocked, which is
 * exactly the defect above. So "I cannot tell" must fall to the permissive side and report
 * nothing — the caller's own comment already called an unparseable URL "not a reliable signal".
 */
export function isSameSite(a: string, b: string): boolean {
  // `siteHost` is shared with ir.ts's `pageKey`, which had to learn the same lesson separately
  // (TD-82). One definition, so the next comparison that needs it cannot drift from this one.
  const ha = siteHost(a);
  const hb = siteHost(b);
  if (!ha || !hb) return true;
  return ha === hb;
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
  } else if (appOrigin && finalUrl && !isSameSite(finalUrl, appOrigin)) {
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

/** What a failed case can say for itself with no model call at all. */
export interface FailureDetail {
  /** 1-based index of the step that threw, matching the step numbering in the UI and IR. */
  failedStep?: number;
  /** That step's own title, e.g. `Select 'prashant mishra' in 'Manager'`. */
  failedStepTitle?: string;
  /** First meaningful line of the Playwright error. */
  error?: string;
  /** The full message, ANSI stripped — for the "show more" the card can expand into. */
  errorDetail?: string;
}

/** Strip ANSI colour codes; Playwright's JSON keeps them in `message`. */
const noAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, "");

/**
 * Pull the failure out of Playwright's own JSON report.
 *
 * WHY THIS EXISTS. A replay makes zero LLM calls by design, so `analyzeFailure` never runs and
 * the UI — which only rendered a reason when a diagnosis existed — showed a red X and nothing
 * else. On run `2026-09-06T14-19-13-154Z-fed833e5` the actual cause was sitting unread in
 * `05-result.json` the whole time. This is the deterministic floor: every failed case can say
 * which step died and what the error was, whatever the run type and whatever the budget.
 * A diagnosis, when there is one, is shown BELOW this rather than instead of it.
 *
 * Pure over the parsed report so it is testable without running a browser.
 */
export function extractFailureDetail(raw: any): FailureDetail {
  if (!raw || typeof raw !== "object") return {};
  let out: FailureDetail = {};

  const visitSuite = (suite: any) => {
    for (const child of suite?.suites ?? []) visitSuite(child);
    for (const spec of suite?.specs ?? []) {
      if (spec?.ok) continue;
      for (const test of spec?.tests ?? []) {
        for (const result of test?.results ?? []) {
          const steps = result?.steps ?? [];
          // Playwright numbers nothing; the position of the failing step IS the step number,
          // because generateSpec emits exactly one test.step() per IR step in order.
          for (let i = 0; i < steps.length; i++) {
            if (!steps[i]?.error) continue;
            if (out.failedStep === undefined) {
              out.failedStep = i + 1;
              out.failedStepTitle = typeof steps[i].title === "string" ? steps[i].title : undefined;
            }
          }
          for (const err of result?.errors ?? []) {
            const msg = typeof err?.message === "string" ? noAnsi(err.message) : "";
            if (!msg.trim()) continue;
            // "Test timeout of 50000ms exceeded" is the CONSEQUENCE of the first error, not a
            // second failure — it would otherwise displace the real cause on the card.
            if (!out.error) {
              out.error = msg.split("\n").map((l) => l.trim()).filter(Boolean)[0];
              out.errorDetail = msg;
            }
          }
        }
      }
    }
  };
  for (const suite of raw.suites ?? []) visitSuite(suite);
  for (const err of raw.errors ?? []) {
    if (!out.error && typeof err?.message === "string" && err.message.trim()) {
      out.error = noAnsi(err.message).split("\n")[0].trim();
      out.errorDetail = noAnsi(err.message);
    }
  }
  return out;
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
 * WHICH cases have one is a config question, not this function's: playwright.config.ts defaults
 * `video` to "retain-on-failure" (so only a case Playwright itself failed keeps a recording), and
 * `PLAYWRIGHT_VIDEO=on` records every case including passing ones. Either way this is a pure
 * "is there a file" lookup and needs no status check — a case with no recording returns null.
 *
 * Note the default's blind spot, which is why the flag exists: `blocked`, `truncated` and
 * `truncated_no_assertion` are all outcomes where PLAYWRIGHT PASSED and the pipeline reclassified
 * the result afterwards. Under "retain-on-failure" Playwright has already deleted those
 * recordings by then, so those cards can never show a video without the flag.
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
