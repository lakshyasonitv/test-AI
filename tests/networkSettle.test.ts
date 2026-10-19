import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { extractDomModelFromPage } from "../src/stages/domDiscovery.js";
import { trackNetwork, waitForNetworkSettle } from "../src/stages/networkSettle.js";

// Discovery upgrade Phase 1 (NETWORK_SETTLE_ENABLED), in a REAL Chromium against a real local HTTP
// server (D-19): a page's fields can arrive from a fetch that finishes after the DOM looked ready,
// and a Salesforce-style CometD long-poll never finishes at all.

const page = (body: string) => `<!doctype html><html><body><h1>Form</h1><button>Start</button>${body}</body></html>`;

// The field arrives from a fetch the server answers after 1.8 s: after the 800 ms every discovery
// call site already waits, so a snapshot taken then models the form without it.
const DELAYED = page(`<form id="f"></form><script>
  fetch("/api/field").then(r => r.text()).then(() => {
    document.getElementById("f").innerHTML = '<label for="df">Delayed Field</label><input id="df" name="df">';
  });
</script>`);

// A Bayeux long-poll (by URL and body) that the server never answers, plus one ordinary fetch.
const LONG_POLL = page(`<div id="d"></div><script>
  fetch("/cometd/58.0/connect", { method: "POST", body: '[{"channel":"/meta/connect","connectionType":"long-polling"}]' });
  fetch("/api/data").then(() => { document.getElementById("d").innerHTML = '<input aria-label="Loaded">'; });
</script>`);

// A request with no streaming shape that also never answers: set aside once it is older than
// LONG_LIVED_MS, so the page still settles inside the cap.
const HANGING = page(`<script>fetch("/api/never-answers");</script>`);

// A page that never stops fetching: the wait must give up at the cap, not hang.
const CHATTY = page(`<script>setInterval(() => fetch("/api/tick"), 150);</script>`);

let server: http.Server;
let base = "";
let browser: Browser;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const send = (body: string, type = "text/html") => { res.writeHead(200, { "content-type": type }); res.end(body); };
    if (req.url === "/delayed") return send(DELAYED);
    if (req.url === "/longpoll") return send(LONG_POLL);
    if (req.url === "/hanging") return send(HANGING);
    if (req.url === "/chatty") return send(CHATTY);
    if (req.url === "/api/field") { setTimeout(() => send("ok", "text/plain"), 1800); return; }
    if (req.url === "/api/data") { setTimeout(() => send("ok", "text/plain"), 300); return; }
    if (req.url === "/api/tick") { setTimeout(() => send("ok", "text/plain"), 100); return; }
    // /cometd/... and /api/never-answers: held open, never answered.
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

afterEach(() => { delete process.env.NETWORK_SETTLE_ENABLED; delete process.env.DISCOVERY_LIVE_DOM; });

/** What a discovery call site does: goto, the fixed 800 ms, then the snapshot. */
async function snapshot(path: string, settle: boolean): Promise<string[]> {
  if (settle) process.env.NETWORK_SETTLE_ENABLED = "true";
  const p = await browser.newPage();
  try {
    if (settle) trackNetwork(p); // what the call sites do with the flag on: before goto
    await p.goto(base + path, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(800);
    const model = await extractDomModelFromPage(p, base + path);
    return (model?.pages[0]?.elements ?? []).map((e) => e.name);
  } finally {
    await p.close();
  }
}

describe("Phase 1: wait until the page really finished loading", () => {
  for (const strategy of ["cheerio", "live"] as const) {
    it(`[${strategy}] a field loaded by a delayed fetch is missed with the flag OFF and captured with it ON`, async () => {
      if (strategy === "live") process.env.DISCOVERY_LIVE_DOM = "true";
      expect(await snapshot("/delayed", false)).not.toContain("Delayed Field");
      if (strategy === "live") process.env.DISCOVERY_LIVE_DOM = "true";
      expect(await snapshot("/delayed", true)).toContain("Delayed Field");
    }, 30_000);
  }

  it("a never-ending CometD long-poll is ignored by its shape, so the page settles quickly", async () => {
    const p = await browser.newPage();
    try {
      trackNetwork(p);
      await p.goto(base + "/longpoll", { waitUntil: "domcontentloaded" });
      const r = await waitForNetworkSettle(p);
      expect(r.settled).toBe(true);
      expect(r.waitedMs).toBeLessThan(2500);
      expect(r.ignoredLongLived).toBeGreaterThanOrEqual(1);
      expect(await p.getByLabel("Loaded").count()).toBe(1); // the ordinary fetch was waited for
    } finally {
      await p.close();
    }
  }, 30_000);

  it("a request with no streaming shape that never answers is set aside by age, inside the cap", async () => {
    const p = await browser.newPage();
    try {
      trackNetwork(p);
      await p.goto(base + "/hanging", { waitUntil: "domcontentloaded" });
      const r = await waitForNetworkSettle(p);
      expect(r.settled).toBe(true);
      expect(r.waitedMs).toBeGreaterThanOrEqual(3000); // it did wait for it, up to LONG_LIVED_MS
      expect(r.waitedMs).toBeLessThan(5000);
    } finally {
      await p.close();
    }
  }, 30_000);

  it("attaching twice keeps ONE tracker: no extra listeners, and the in-flight count stays correct", async () => {
    const p = await browser.newPage();
    try {
      const first = trackNetwork(p);
      const listeners = p.listenerCount("request") + p.listenerCount("requestfinished") + p.listenerCount("requestfailed");
      const second = trackNetwork(p); // what the crawl (page creation) + the snapshot both do
      expect(second).toBe(first);
      expect(p.listenerCount("request") + p.listenerCount("requestfinished") + p.listenerCount("requestfailed"))
        .toBe(listeners);
      await p.goto(base + "/delayed", { waitUntil: "domcontentloaded" });
      // Exactly the one /api/field fetch is in flight (answered after 1.8 s), not two.
      await p.waitForTimeout(300);
      expect(second.pending()).toBe(1);
      const r = await waitForNetworkSettle(p);
      expect(r.settled).toBe(true);
      expect(second.pending()).toBe(0);
    } finally {
      await p.close();
    }
  }, 30_000);

  it("closing the page clears its tracker: no in-flight Request is still held afterwards", async () => {
    const p = await browser.newPage();
    const t = trackNetwork(p);
    await p.goto(base + "/hanging", { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(200);
    expect(t.pending()).toBe(1); // /api/never-answers is in flight
    await p.close();
    expect(t.pending()).toBe(0); // cleared on close, nothing left holding the Request
  }, 30_000);

  it("a page that never stops fetching gives up at the cap instead of hanging", async () => {
    const p = await browser.newPage();
    try {
      trackNetwork(p);
      await p.goto(base + "/chatty", { waitUntil: "domcontentloaded" });
      const r = await waitForNetworkSettle(p);
      expect(r.settled).toBe(false);
      expect(r.waitedMs).toBeGreaterThanOrEqual(5000);
      expect(r.waitedMs).toBeLessThan(6000);
    } finally {
      await p.close();
    }
  }, 30_000);
});
