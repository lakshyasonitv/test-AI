import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import path from "node:path";

/**
 * D-73, run for real (D-19): three suite cases through the REAL generateSpec and runSpec at
 * SUITE_CASE_CONCURRENCY=3 — three Playwright processes, three Chromiums, at once. Only toIR (the
 * model) is mocked. The page holds every load for a moment and counts the loads in flight, so the
 * test proves the browsers really overlapped, and each case asserts its own value, so a case that
 * read another case's results.json or artifacts would fail.
 */

const { toIRMock } = vi.hoisted(() => ({ toIRMock: vi.fn() }));
vi.mock("../src/stages/ir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/stages/ir.js")>()), toIR: toIRMock,
}));

const { runSuite, _resetCaseSlots } = await import("../src/stages/suiteRunner.js");

const FORM = `<!doctype html><html><head><title>Form</title></head><body><main>
<form id="f"><label for="n">Account Name</label><input id="n" name="n"><button>Save</button></form>
<p id="out"></p>
<script>
document.getElementById("f").onsubmit = (e) => {
  e.preventDefault();
  document.getElementById("out").textContent = "Saved " + document.getElementById("n").value;
};
</script></main></body></html>`;

let server: http.Server;
let base = "";
const loads = { now: 0, max: 0 };
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (!req.url?.startsWith("/form")) { res.statusCode = 404; res.end(""); return; }
    loads.now++; loads.max = Math.max(loads.max, loads.now);
    // Held long enough that three browsers started together are all waiting here at once.
    setTimeout(() => { loads.now--; res.setHeader("content-type", "text/html"); res.end(FORM); }, 2500);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

// Playwright only finds specs under ./runs (playwright.config.ts testDir).
const runDir = path.join("runs", `0000-suiteparallel-${process.pid}-${Date.now()}`);
afterAll(() => rmSync(runDir, { recursive: true, force: true }));

describe("parallel suite cases in real browsers", () => {
  it("three cases run at once, each passes on its own value", async () => {
    const saved = process.env.SUITE_CASE_CONCURRENCY;
    process.env.SUITE_CASE_CONCURRENCY = "3";
    _resetCaseSlots();
    vi.spyOn(console, "log").mockImplementation(() => {});
    toIRMock.mockImplementation(async (tc: any) => ({
      updatedAppModel: { baseUrl: base, pages: [] },
      ir: {
        meta: { feature: "f", title: tc.title, priority: "high", sourcePrompt: "p", baseUrl: base },
        steps: [
          { id: "s1", action: "navigate", target: { url: "/form" } },
          { id: "s2", action: "fill", target: { role: "textbox", name: "Account Name" }, value: `${tc.title} {{uid}}` },
          { id: "s3", action: "click", target: { role: "button", name: "Save" } },
          { id: "s4", action: "assert", assertion: "visible", target: { text: `Saved ${tc.title} {{uid}}` } },
        ],
      },
    }));
    try {
      const cases = ["Acme A", "Acme B", "Acme C"].map((title) => ({
        title, intent: "i", expected: "e", whyItMatters: "w", category: "valid", priority: "high",
      })) as any[];
      const results = await runSuite(cases, { baseUrl: base, pages: [] } as any, runDir, "p", base);
      expect(results.map((r) => [r.title, r.status])).toEqual([
        ["Acme A", "passed"], ["Acme B", "passed"], ["Acme C", "passed"],
      ]);
      expect(loads.max).toBeGreaterThanOrEqual(2);
    } finally {
      if (saved === undefined) delete process.env.SUITE_CASE_CONCURRENCY; else process.env.SUITE_CASE_CONCURRENCY = saved;
      _resetCaseSlots();
      vi.restoreAllMocks();
    }
  }, 300_000);
});
