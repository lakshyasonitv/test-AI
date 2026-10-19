import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { enumerateLiveElements } from "../src/stages/liveDomDiscovery.js";
import { withTargetApp } from "../src/runTarget.js";
import { dropVolatileIdCss } from "../src/stages/volatileIds.js";

// Discovery upgrade Phase 4 (VOLATILE_ID_DETECTION_ENABLED), in a REAL Chromium against a local
// server (D-19): the emitted css is what grounding and the generated spec use, so it is executed,
// not string-checked. Every walk opens a NEW browser page, as a replay does.
//
// Isolation: the evidence lives in the shared on-disk cache, so each test gets its own
// LLM_CACHE_VERSION (part of the key) and nothing ever clears a namespace (the screenMap tests' rule).

let server: http.Server;
let base = "";
let browser: Browser;
let visits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    visits++;
    // "Save" gets a new numbered id on every visit, the way Lightning numbers per session.
    // "Select" keeps a meaningful numbered id (TD-133's `unit-102`). "Cancel" has a plain stable id.
    if (req.url === "/form") {
      return res.end(`<!doctype html><body><h1>Form</h1>
        <button id="save-${100 + visits}">Save</button>
        <button id="unit-102">Select</button>
        <button id="cancel">Cancel</button></body>`);
    }
    // Two "Open" buttons, one on the page and one in a dialog: role + name is NOT unique on the page,
    // and both keep the same numbered id on every visit.
    if (req.url === "/twins") {
      return res.end(`<!doctype html><body><h1>Twins</h1>
        <button id="open-12">Open</button>
        <div role="dialog" aria-label="Edit"><button id="open-34">Open</button></div></body>`);
    }
    res.end("<!doctype html><body></body>");
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
beforeEach(() => { process.env.LLM_CACHE_VERSION = `test-vid-${Date.now()}-${Math.random()}`; });
afterEach(() => {
  delete process.env.VOLATILE_ID_DETECTION_ENABLED;
  if (savedVersion === undefined) delete process.env.LLM_CACHE_VERSION; else process.env.LLM_CACHE_VERSION = savedVersion;
});

/** One walk in a fresh page, as `app` (null = an ordinary site). Returns css by element name. */
async function walk(app: "salesforce" | null, at = "/form"): Promise<Record<string, string>> {
  return withTargetApp(app, async () => {
    const p = await browser.newPage();
    try {
      await p.goto(base + at);
      const els = await enumerateLiveElements(p);
      return Object.fromEntries(els.filter((e) => e.role === "button").map((e) => [e.name, e.css ?? ""]));
    } finally {
      await p.close();
    }
  });
}

/** Does `css` find exactly one element on a FRESH visit (new ids)? */
async function resolvesOnNextVisit(css: string, name: string, at = "/form"): Promise<boolean> {
  const p = await browser.newPage();
  try {
    await p.goto(base + at);
    const l = p.locator(css);
    return (await l.count()) === 1 && (await l.textContent())?.trim() === name;
  } finally {
    await p.close();
  }
}

describe("Phase 4: ids that change every visit", () => {
  it("flag OFF (today, ordinary site): the per-visit id is used, and it is dead on the next visit", async () => {
    const first = await walk(null);
    expect(first.Save).toMatch(/^#save-\d+$/);
    expect(await resolvesOnNextVisit(first.Save, "Save")).toBe(false);
  }, 60_000);

  it("flag ON, ordinary site: one sighting keeps today's choice; the second marks the id volatile and drops it", async () => {
    process.env.VOLATILE_ID_DETECTION_ENABLED = "true";
    const first = await walk(null);
    expect(first.Save).toMatch(/^#save-\d+$/); // no evidence yet: today's rule
    const second = await walk(null);
    expect(second.Save).not.toMatch(/save-\d+/); // changed between walks → never a locator again
    expect(second.Save).not.toBe("");
    expect(await resolvesOnNextVisit(second.Save, "Save")).toBe(true);
    // A stable id is untouched.
    expect(second.Cancel).toBe("#cancel");
    // And it stays volatile on later walks.
    expect((await walk(null)).Save).not.toMatch(/save-\d+/);
  }, 60_000);

  it("flag ON, Salesforce: a stable numbered id is only a FALLBACK; a unique role locator still wins", async () => {
    process.env.VOLATILE_ID_DETECTION_ENABLED = "true";
    const first = await walk("salesforce");
    expect(first.Select).not.toBe("#unit-102"); // one sighting: the D-55 pattern rule still drops it
    const second = await walk("salesforce");
    // Proven stable, but "Select" is unique by role + name, so the D-55 role locator comes first.
    expect(second.Select).toBe('role=button[name="Select"s]');
    expect(await resolvesOnNextVisit(second.Select, "Select")).toBe(true);
    // The per-visit id is dropped by the pattern rule AND by the evidence.
    expect(second.Save).not.toMatch(/save-\d+/);
  }, 60_000);

  it("flag ON, Salesforce: when no role/label locator is unique, the stable id beats the positional path", async () => {
    process.env.VOLATILE_ID_DETECTION_ENABLED = "true";
    const ordered = async () => withTargetApp("salesforce", async () => {
      const p = await browser.newPage();
      try {
        await p.goto(base + "/twins");
        return (await enumerateLiveElements(p)).filter((e) => e.name === "Open").map((e) => e.css ?? "");
      } finally { await p.close(); }
    });
    const first = await ordered();
    expect(first.some((c) => /open-\d+/.test(c))).toBe(false); // one sighting: pattern rule, positional
    const second = await ordered();
    expect(second).toEqual(["#open-12", "#open-34"]); // role=button[name="Open"s] matches 2: not unique
    for (const [i, css] of second.entries()) {
      const p = await browser.newPage();
      try { await p.goto(base + "/twins"); expect(await p.locator(css).count()).toBe(1); } finally { await p.close(); }
      void i;
    }
  }, 60_000);

  it("flag OFF, Salesforce: today's pattern rule, unchanged by the store", async () => {
    await walk("salesforce");
    expect((await walk("salesforce")).Select).not.toBe("#unit-102");
  }, 60_000);

  it("a cached DISCOVERY model (app-model cache) loses an id css once that id is proven volatile", async () => {
    process.env.VOLATILE_ID_DETECTION_ENABLED = "true";
    const { cacheGet, cacheSet } = await import("../src/kb/cache.js");
    // Unique URL: a cache file nothing else can read. Same page key as /form (the query is ignored).
    const url = `${base}/form?probe=${Math.random()}`;
    cacheSet(url, { baseUrl: base, pages: [{ url: base + "/form", title: "Form", concepts: [],
      elements: [{ role: "button", name: "Save", css: "#save-777" }, { role: "button", name: "Cancel", css: "#cancel" }] }] } as any);
    await walk(null);
    await walk(null); // Save proven volatile
    const served = cacheGet(url)!;
    expect(served.pages[0].elements.find((e) => e.name === "Save")?.css).toBeUndefined();
    expect(served.pages[0].elements.find((e) => e.name === "Cancel")?.css).toBe("#cancel");
  }, 60_000);

  it("a cached page model loses an id css once that id is proven volatile", async () => {
    process.env.VOLATILE_ID_DETECTION_ENABLED = "true";
    await walk(null);
    await walk(null); // Save proven volatile
    const cachedEls = [{ role: "button", name: "Save", css: "#save-101" }, { role: "button", name: "Cancel", css: "#cancel" }];
    expect(dropVolatileIdCss(base + "/form", cachedEls)).toBe(1);
    expect(cachedEls[0].css).toBeUndefined();
    expect(cachedEls[1].css).toBe("#cancel");
  }, 60_000);
});
