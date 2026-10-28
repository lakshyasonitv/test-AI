import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { extractDomModelFromPage } from "../src/stages/domDiscovery.js";
import { exploreButtons, classifyControl, isLightningAppUrl } from "../src/stages/buttonExplorer.js";
import { loadScreenMap } from "../src/stages/screenMap.js";
import { withTargetApp } from "../src/runTarget.js";
import type { AppModel } from "../src/schema/appModel.js";

// Discovery upgrade Phase 5 (BUTTON_EXPLORER_ENABLED): the safe explorer, in a REAL Chromium against
// a local server (D-19). The server counts every destructive request, so "never clicked" is proven
// by the server, not by the explorer's own report.

const ACCOUNTS = `<!doctype html><html><body>
  <h1>Accounts</h1>
  <div role="tablist">
    <button role="tab" aria-selected="true" id="t1">Overview</button>
    <button role="tab" aria-selected="false" id="t2">Details</button>
  </div>
  <div id="p1"><label>Search accounts <input></label></div>
  <div id="p2" hidden><label>Billing City <input></label><label>Billing Zip <input></label><label>Billing Country <input></label></div>
  <button id="new">New</button>
  <div role="dialog" aria-label="New Account" id="dlg" hidden>
    <h2>New Account</h2><label>Account Name <input></label><label>Phone <input></label><button id="close">Close</button>
  </div>
  <button id="del">Delete</button>
  <form method="post" action="/submit"><label>Note <input></label><button>Go</button></form>
  <a href="/all">View all</a>
  <a href="https://partner.invalid/">View partner site</a>
  <script>
    t2.onclick = () => { p1.hidden = true; p2.hidden = false; t1.setAttribute("aria-selected","false"); t2.setAttribute("aria-selected","true"); };
    t1.onclick = () => { p1.hidden = false; p2.hidden = true; };
    document.getElementById("new").onclick = () => { dlg.hidden = false; };
    close.onclick = () => { dlg.hidden = true; };
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") dlg.hidden = true; });
    del.onclick = () => { fetch("/delete", { method: "POST" }); };
  </script>
</body></html>`;
// An ALLOWED control (a tab) whose click posts a form from script: only the network guard stops it.
const SNEAKY = `<!doctype html><html><body><h1>Sneaky</h1><div role="tablist"><button role="tab" aria-selected="false" id="tb">Summary</button></div>
  <form method="post" action="/submit" id="f"><input name="x" value="1" type="hidden"></form>
  <script>tb.onclick = () => document.getElementById("f").submit();</script></body></html>`;
// Screen Flow buttons: one flowruntime container in the light DOM, one lightning-flow whose buttons sit in a SHADOW
// root (Lightning's shape). Every button pings the server, so "never clicked" is proven by the server. The one
// control outside any flow is allowed and must still be clicked.
const FLOW = `<!doctype html><html><body><h1>Flow</h1>
  <flowruntime-flow><div><button onclick="fetch('/flow-click')">Next</button><button onclick="fetch('/flow-click')">Show details</button></div></flowruntime-flow>
  <lightning-flow id="lf"></lightning-flow>
  <button onclick="fetch('/ok-click')">View summary</button>
  <script>
    const r = document.getElementById("lf").attachShadow({ mode: "open" });
    r.innerHTML = '<div><button>Expand section</button></div>';
    r.querySelector("button").onclick = () => fetch("/flow-click");
  </script></body></html>`;
const ALL = `<!doctype html><html><body><h1>All accounts</h1><label>Filter <input></label><button>Next</button></body></html>`;

let server: http.Server;
let base = "";
let browser: Browser;
const hits = { delete: 0, submit: 0, flow: 0, ok: 0 };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/delete") { hits.delete++; res.writeHead(200); return res.end("deleted"); }
    if (req.url === "/flow-click") { hits.flow++; res.writeHead(200); return res.end("ok"); }
    if (req.url === "/ok-click") { hits.ok++; res.writeHead(200); return res.end("ok"); }
    if (req.url === "/flow") { res.writeHead(200, { "content-type": "text/html" }); return res.end(FLOW); }
    if (req.url === "/submit") { hits.submit++; res.writeHead(200, { "content-type": "text/html" }); return res.end("<h1>Saved</h1>"); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/all" ? ALL : req.url === "/sneaky" ? SNEAKY : ACCOUNTS);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const savedVersion = process.env.LLM_CACHE_VERSION;
let runDir = "";
beforeEach(() => {
  process.env.LLM_CACHE_VERSION = `test-explorer-${Date.now()}-${Math.random()}`; // never meets real entries
  process.env.DISCOVERY_LIVE_DOM = "true";
  runDir = mkdtempSync(path.join(os.tmpdir(), "explorer-"));
  hits.delete = 0; hits.submit = 0; hits.flow = 0; hits.ok = 0;
});
afterEach(() => {
  for (const k of ["DISCOVERY_LIVE_DOM", "EXPLORER_MAX_CLICKS", "SCREEN_MAP_ENABLED"]) delete process.env[k];
  if (savedVersion === undefined) delete process.env.LLM_CACHE_VERSION; else process.env.LLM_CACHE_VERSION = savedVersion;
  rmSync(runDir, { recursive: true, force: true });
});

/** Discovery's model of the page, as a real run would have it. */
async function discovered(): Promise<AppModel> {
  const p = await browser.newPage();
  try {
    await p.goto(base + "/accounts");
    return (await extractDomModelFromPage(p, base + "/accounts"))!;
  } finally {
    await p.close();
  }
}

describe("Phase 5: the safe button explorer", () => {
  it("the policy: deny always wins, then structure, then the name allow-list", () => {
    expect(classifyControl({ role: "button", name: "Delete", hasPopup: true }).click).toBe(false);
    expect(classifyControl({ role: "tab", name: "Remove filter" }).click).toBe(false);
    expect(classifyControl({ role: "button", name: "Go", submitInForm: true }).click).toBe(false);
    expect(classifyControl({ role: "link", name: "View partner", external: true }).click).toBe(false);
    expect(classifyControl({ role: "tab", name: "Details" }).click).toBe(true);
    expect(classifyControl({ role: "button", name: "Actions", hasPopup: true }).click).toBe(true);
    expect(classifyControl({ role: "button", name: "New" }).click).toBe(true);
    expect(classifyControl({ role: "button", name: "Frobnicate" }).click).toBe(false);
  });

  it("finds the tab's screen, the dialog and the new page; never deletes, never submits", async () => {
    const before = await discovered();
    const { model, report } = await exploreButtons(before, { runDir });

    const clicked = report.clicks.map((c) => `${c.name}:${c.outcome}`);
    expect(clicked).toContain("Details:new-screen");
    expect(clicked).toContain("New:new-screen");
    expect(clicked).toContain("View all:new-page");
    expect(report.clicks.every((c) => c.outcome === "no-change" || c.restored === "yes")).toBe(true);

    const skipped = Object.fromEntries(report.skipped.map((s) => [s.name, s.reason]));
    expect(skipped.Delete).toMatch(/^deny/);
    expect(skipped.Go).toBe("deny: submit button inside a form");
    expect(skipped["View partner site"]).toBe("deny: leaves the site's origin");

    // Proven by the SERVER, not by the report.
    expect(hits.delete).toBe(0);
    expect(hits.submit).toBe(0);

    // The new same-origin page is a real snapshot in the model; the report is on disk.
    expect(model.pages.map((p) => new URL(p.url).pathname)).toEqual(["/accounts", "/all"]);
    const onDisk = JSON.parse(readFileSync(path.join(runDir, "explorer.json"), "utf8"));
    expect(onDisk.clicks.length).toBe(report.clicks.length);
    expect(onDisk.skipped.length).toBe(report.skipped.length);
  }, 120_000);

  it("on a Salesforce run with the screen map on, the screens and the clicks that open them are stored", async () => {
    process.env.SCREEN_MAP_ENABLED = "true";
    const before = await discovered();
    await withTargetApp("salesforce", () => exploreButtons(before, { runDir }));
    const map = loadScreenMap(base, undefined, new Date());
    expect(map.screens.map((s) => s.title)).toContain("new account");
    expect(map.edges.some((e) => e.action.name === "New")).toBe(true);
    expect(map.edges.some((e) => e.action.name === "Details")).toBe(true);
    // Names only: nothing in the map looks like a selector.
    expect(JSON.stringify(map)).not.toMatch(/#t2|#new|nth-of-type/);
  }, 120_000);

  it("the network guard aborts a form POST even when the clicked control was allowed", async () => {
    const p = await browser.newPage();
    let model: AppModel;
    try { await p.goto(base + "/sneaky"); model = (await extractDomModelFromPage(p, base + "/sneaky"))!; } finally { await p.close(); }
    const { report } = await exploreButtons(model, { runDir });
    expect(report.clicks.map((c) => c.name)).toContain("Summary");
    expect(hits.submit).toBe(0);
  }, 120_000);

  it("Salesforce safety: a Lightning app's Next/Finish and anything inside a Screen Flow are never clicked", () => {
    expect(isLightningAppUrl("https://acme.lightning.force.com/lightning/r/Lead/00Q1/view")).toBe(true);
    expect(isLightningAppUrl("https://acme.my.salesforce.com/lightning/page/home")).toBe(true);
    expect(isLightningAppUrl("https://acme--dev.sandbox.my.site.com/s/")).toBe(false); // Experience Cloud
    expect(classifyControl({ role: "button", name: "Next", lightningApp: true }).why).toBe("deny: Next/Finish on a Salesforce Lightning app");
    expect(classifyControl({ role: "button", name: "Finish", lightningApp: true }).click).toBe(false);
    expect(classifyControl({ role: "button", name: "Next", lightningApp: false }).click).toBe(true); // Experience site
    expect(classifyControl({ role: "tab", name: "Details", inFlow: true }).why).toBe("deny: inside a Salesforce Screen Flow");
  });

  it("a Screen Flow's buttons (light DOM and inside a shadow root) are skipped in a real browser", async () => {
    const p = await browser.newPage();
    let model: AppModel;
    try { await p.goto(base + "/flow"); model = (await extractDomModelFromPage(p, base + "/flow"))!; } finally { await p.close(); }
    const { report } = await exploreButtons(model, { runDir });
    const reasons = Object.fromEntries(report.skipped.map((s) => [s.name, s.reason]));
    expect(reasons.Next).toBe("deny: inside a Salesforce Screen Flow");
    expect(reasons["Show details"]).toBe("deny: inside a Salesforce Screen Flow");
    expect(reasons["Expand section"]).toBe("deny: inside a Salesforce Screen Flow");
    expect(report.clicks.map((c) => c.name)).toEqual(["View summary"]);
    expect(hits.flow).toBe(0); // proven by the server
    expect(hits.ok).toBe(1);
  }, 120_000);

  it("respects EXPLORER_MAX_CLICKS", async () => {
    process.env.EXPLORER_MAX_CLICKS = "1";
    const { report } = await exploreButtons(await discovered(), { runDir });
    expect(report.clicks).toHaveLength(1);
    expect(report.stoppedBecause).toBe("EXPLORER_MAX_CLICKS reached");
  }, 120_000);
});
