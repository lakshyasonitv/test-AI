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

export async function runSpec(specCode: string, runDir: string): Promise<ExecResult> {
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

  // Retry logic for flaky tests
  let attempts = 0;
  let lastError: any;
  
  while (attempts < CONFIG.RETRIES) {
    try {
      const result = await executePlaywright(specPath, resultsJson, artifactsDir, cliPath);
      
      // If test passed or failed with assertion error (not transient), return immediately
      if (result.passed || result.exitCode === 1) {
        return result;
      }
      
      // Transient error, retry
      attempts++;
      if (attempts < CONFIG.RETRIES) {
        console.log(`[executor] Retrying test (attempt ${attempts + 1}/${CONFIG.RETRIES})...`);
        await sleep(CONFIG.TIMEOUTS.RETRY_DELAY);
      } else {
        return result;
      }
    } catch (error) {
      lastError = error;
      attempts++;
      if (attempts < CONFIG.RETRIES) {
        console.log(`[executor] Retrying after error (attempt ${attempts + 1}/${CONFIG.RETRIES})...`);
        await sleep(CONFIG.TIMEOUTS.RETRY_DELAY);
      }
    }
  }
  
  throw lastError || new Error('Test failed after retries');
}

async function executePlaywright(
  specPath: string, 
  resultsJson: string, 
  artifactsDir: string, 
  cliPath: string
): Promise<ExecResult> {
  const exitCode: number = await new Promise((resolve) => {
    console.log("[executor] Spawning Playwright...");
    const p = spawn(
      process.execPath,
      [cliPath, "test", specPath.replace(/\\/g, "/"), "--reporter=json", `--output=${artifactsDir}`],
      {
        env: {
          ...process.env,
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
