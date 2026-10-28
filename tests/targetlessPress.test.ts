import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { generateSpec } from "../src/stages/generator.js";
import { runSpec } from "../src/stages/executor.js";
import { runStepLive } from "../src/stages/liveExtend.js";
import { chromiumLaunchOptions } from "../src/browserLaunch.js";
import type { IR } from "../src/schema/ir.js";

/**
 * A `press` step with no target ("press Enter" right after a fill) is legal IR — the step editor
 * renders it as "Press the Enter key" — but generator.ts and liveExtend.ts both read
 * `step.target!.frame`, so it threw "Cannot read properties of undefined (reading 'frame')" and the
 * run died at the generate stage (run 2026-10-28T05-23-15-586Z-2e6fd7ae, a Salesforce "create an
 * account" case). It now presses the key on whatever has focus. Run for real (D-19): the emitted
 * line through the real executor, and the replay in real Chromium.
 */

// Enter in the box submits the form, which says so on the page.
const FORM = `<!doctype html><html><head><title>Form</title></head><body><main>
<form id="f"><label for="n">Account Name</label><input id="n" name="n"></form>
<p id="out"></p>
<script>
document.getElementById("f").onsubmit = (e) => {
  e.preventDefault();
  document.getElementById("out").textContent = "Saved " + document.getElementById("n").value;
};
</script></main></body></html>`;

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/form")) res.end(FORM); else { res.statusCode = 404; res.end(""); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const irFor = (baseUrl: string): IR => ({
  meta: { feature: "f", title: "Save with Enter", priority: "high", sourcePrompt: "save with enter", baseUrl },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/form" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Account Name" }, value: "Acme" },
    { id: "s3", action: "press", value: "Enter" },
    { id: "s4", action: "assert", assertion: "visible", target: { text: "Saved Acme" } },
  ],
} as unknown as IR);

describe("a press step with no target", () => {
  it("generates a keyboard press instead of throwing", () => {
    const spec = generateSpec(irFor("https://example.com"), "artifacts");
    expect(spec).toContain(`await page.keyboard.press("Enter");`);
    expect(spec).toContain(`test.step("Press 'Enter'",`);
  });

  // Playwright only finds specs under ./runs (playwright.config.ts testDir): a short-lived folder there,
  // named to sort after every real run, removed afterwards.
  const runDir = path.join("runs", `0000-targetlesspress-${process.pid}-${Date.now()}`);
  afterAll(() => rmSync(runDir, { recursive: true, force: true }));

  it("the generated spec submits the form when it really runs", async () => {
    mkdirSync(runDir, { recursive: true });
    const spec = generateSpec(irFor(base), path.join(runDir, "artifacts"));
    const result = await runSpec(spec, runDir, {});
    expect(result.passed).toBe(true);
  }, 240_000);

  it("the live replay presses the key on the focused field", async () => {
    const browser = await chromium.launch(chromiumLaunchOptions());
    try {
      const page = await browser.newPage();
      for (const step of irFor(base).steps.slice(0, 3)) await runStepLive(page, step, base);
      await expect.poll(() => page.locator("#out").textContent()).toBe("Saved Acme");
    } finally { await browser.close(); }
  }, 60_000);
});
