import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface ExecResult {
  passed: boolean;
  exitCode: number;
  resultsJsonPath: string;
  artifactsDir: string;
  raw: any | null;
}

export async function runSpec(specCode: string, runDir: string): Promise<ExecResult> {
  const genDir = path.join(runDir, "generated");
  mkdirSync(genDir, { recursive: true });
  const specPath = path.join(genDir, "test.spec.ts");
  writeFileSync(specPath, specCode, "utf8");

  const resultsJson = path.join(runDir, "results.json");
  const artifactsDir = path.join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  // Invoke Playwright's CLI directly via `node <cli.js>` rather than through `npx`/a shell:
  // npx's .cmd shim needs `shell: true` on Windows, and shell mode doesn't safely escape
  // arguments (paths with spaces get mangled). This is portable and avoids both problems.
  const cliPath = path.join(process.cwd(), "node_modules", "@playwright", "test", "cli.js");
  // Playwright treats the file-path argument as a regex matched against test file paths;
  // on Windows, backslash path separators collide with regex escape syntax, so use
  // forward slashes here (Playwright's matcher normalizes paths internally).
  const specArg = specPath.replace(/\\/g, "/");
  const exitCode: number = await new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      [cliPath, "test", specArg, "--reporter=json", `--output=${artifactsDir}`],
      {
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: resultsJson },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = "";
    p.stdout.on("data", d => (out += d.toString()));
    p.stderr.on("data", d => process.stderr.write(d));
    p.on("close", code => {
      if (!existsSync(resultsJson) && out.trim().startsWith("{")) {
        writeFileSync(resultsJson, out, "utf8");
      }
      resolve(code ?? 1);
    });
  });

  let raw: any = null;
  try { raw = JSON.parse(readFileSync(resultsJson, "utf8")); } catch { /* leave null */ }

  return { passed: exitCode === 0, exitCode, resultsJsonPath: resultsJson, artifactsDir, raw };
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
