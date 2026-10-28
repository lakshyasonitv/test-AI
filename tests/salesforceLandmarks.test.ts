import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { enumerateLiveElements } from "../src/stages/liveDomDiscovery.js";
import { withTargetApp } from "../src/runTarget.js";
import { toMicroModel, type AppModel } from "../src/schema/appModel.js";

/**
 * A Salesforce walk records each element's landmark, and the IR prompt's element cap puts the page's
 * own content ahead of the repeated Lightning chrome (run 2026-10-24T06-42-12-486Z-0994a20c: 30 of 74
 * elements kept, all of them header and nav). Ordinary runs: no landmark field, cap order unchanged.
 */

// Lightning's shape in miniature: a banner and a nav ahead of main in document order, and the page's
// own controls inside a web component's shadow root within main.
const PAGE = `<!doctype html><html><body>
<div role="banner"><button>Global Actions</button><button>Setup</button></div>
<div role="navigation" aria-label="Global Header"><a href="/home">Home</a><a href="/leads">Leads</a></div>
<div role="main"><h1>Seller Home</h1><x-card></x-card></div>
<div role="dialog" aria-label="New Lead"><button>Save</button></div>
<script>
customElements.define("x-card", class extends HTMLElement {
  connectedCallback() {
    const r = this.attachShadow({ mode: "open" });
    r.innerHTML = '<button>View Opportunities</button>';
  }
});
</script>
</body></html>`;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
afterAll(async () => { await browser?.close(); });

const sectionOf = (els: { role: string; name: string; pageSection?: string }[], name: string) =>
  els.find((e) => e.name === name)?.pageSection;

describe("Salesforce walk: landmarks", () => {
  it("tags main (through a shadow root), nav and header; a dialog stays a dialog", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(PAGE);
      const els = await withTargetApp("salesforce", () => enumerateLiveElements(page));
      expect(sectionOf(els, "View Opportunities")).toBe("main");
      expect(sectionOf(els, "Leads")).toBe("nav");
      expect(sectionOf(els, "Setup")).toBe("header");
      expect(sectionOf(els, "Save")).toBe("dialog");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("an ordinary run's walk carries no landmark at all (byte-identical to before)", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(PAGE);
      const els = await withTargetApp(null, () => enumerateLiveElements(page));
      for (const name of ["View Opportunities", "Leads", "Setup"]) expect(sectionOf(els, name)).toBeUndefined();
      expect(sectionOf(els, "Save")).toBe("dialog");
    } finally {
      await page.close();
    }
  }, 60_000);
});

// Run 2026-10-24T07-08-34-372Z-e2fc249c in miniature: the same name twice on one page ("Home" in the
// nav and in the content, "Save" on the page and in a modal), wrapped in Aura runtime ids.
const DUPLICATES = `<!doctype html><html><body>
<div id="content_1010:0">
  <div role="navigation" aria-label="Global"><a href="/home">Home</a></div>
  <div role="main" id="brandBand_2"><a href="/home2">Home</a><button>Save</button><button id="brandBand_7">Refresh</button>
    <div><button>Edit</button></div><div><button>Edit</button></div></div>
  <div role="dialog" aria-label="Set Goals"><button>Save</button></div>
</div>
</body></html>`;

describe("Salesforce walk: locators that survive the next page load", () => {
  it("a name repeated on the page is scoped to its dialog or landmark, never anchored on Aura runtime ids", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(DUPLICATES);
      const els = await withTargetApp("salesforce", () => enumerateLiveElements(page));
      const css = (name: string, section: string) => els.find((e) => e.name === name && e.pageSection === section)?.css ?? "";
      expect(css("Home", "nav")).toBe('role=navigation >> role=link[name="Home"s]');
      expect(css("Home", "main")).toBe('role=main >> role=link[name="Home"s]');
      expect(css("Save", "dialog")).toBe('role=dialog >> role=button[name="Save"s]');
      expect(css("Save", "main")).toBe('role=main >> role=button[name="Save"s]');
      // Two "Edit" buttons in the same landmark: neither role locator is unique, so the positional path
      // is used — and it must not be anchored on an Aura runtime id either. (A light-DOM path; only a
      // body-positioned shadow-host chain is dropped, see the aria-hidden test in liveDomDiscovery.)
      const edits = els.filter((e) => e.name === "Edit");
      expect(edits).toHaveLength(2);
      for (const e of edits) expect(e.css ?? "").not.toMatch(/^role=/);
      // Aura ids are never a selector, as an id or as a positional anchor.
      for (const e of els) {
        expect(e.css ?? "").not.toContain("1010:0");
        expect(e.css ?? "").not.toContain("brandBand_");
      }
      // Each chosen selector really resolves to exactly one element.
      for (const name of ["Home", "Save", "Edit"]) {
        for (const e of els.filter((x) => x.name === name)) expect(await page.locator(e.css!).count()).toBe(1);
      }
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("IR prompt cap: the page's own content before the chrome", () => {
  const chrome = Array.from({ length: 40 }, (_, i) => ({ role: "button", name: `Header ${i}`, pageSection: "header" }));
  const content = [
    { role: "button", name: "New Lead", pageSection: "main" },
    { role: "link", name: "Acme Corp", pageSection: "main" },
  ];
  const model = (els: any[]): AppModel => ({ baseUrl: "https://x", pages: [{ url: "https://x/home", title: "Home", elements: els }] } as any);

  it("with landmarks recorded, main content survives a 30-element cap behind 40 header buttons", () => {
    const names = toMicroModel(model([...chrome, ...content])).pages[0].elements.map((e) => e.name);
    expect(names.slice(0, 2)).toEqual(["New Lead", "Acme Corp"]);
    expect(names).toHaveLength(30);
  });

  it("without landmarks, the old order is kept exactly", () => {
    const plain = [...chrome, ...content].map(({ pageSection, ...e }) => e);
    const names = toMicroModel(model(plain)).pages[0].elements.map((e) => e.name);
    expect(names).toEqual(plain.slice(0, 30).map((e) => e.name));
  });

  it("a raised cap (Salesforce runs) keeps everything", () => {
    expect(toMicroModel(model([...chrome, ...content]), { maxElements: 150 }).pages[0].elements).toHaveLength(42);
  });
});
