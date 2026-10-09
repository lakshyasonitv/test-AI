import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { enumerateLiveElements, walkLiveDom } from "../src/stages/liveDomDiscovery.js";
import { extractDomModelFromPage } from "../src/stages/domDiscovery.js";
import type { Element } from "../src/schema/appModel.js";

/**
 * Phase 2 of the live-DOM discovery stream: the light-DOM element walker.
 *
 * Every check here runs in a REAL browser against synthetic HTML (D-19): the walker's whole
 * reason to exist is computed style, layout and in-page selector verification, none of which a
 * string-level test could observe. Selectors are checked by EXECUTING them through Playwright,
 * not by comparing strings — `.filter({ visible: true })` once passed a string check and a unit
 * test while being a silent no-op.
 */

// extractDomModelFromPage (the cheerio comparison below) polls on an empty extraction; these
// pages are static, so there is nothing to wait for.
process.env.DISCOVERY_HYDRATION_POLL_MS = "0";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
afterAll(async () => { await browser.close(); });

const byName = (els: Element[], name: string) => els.filter((e) => e.name === name);

describe("the Salesforce login shape", () => {
  // The bug that made this stream visible: a hidden password-mirror input entered the model as
  // visible with no css, and its name fell back to the HTML `name` attribute.
  const HTML = `
    <form>
      <label for="username">Username</label><input id="username" name="username">
      <label for="password">Password</label><input id="password" type="password" name="pw">
      <input type="text" name="passwordShown" placeholder="Password" style="display:none">
      <input id="Login" type="submit" value="Log In">
    </form>`;

  it("reports the hidden mirror as NOT visible, and gives it a css that resolves to it", async () => {
    await page.setContent(HTML);
    const els = await enumerateLiveElements(page);
    const mirror = els.find((e) => e.css === 'input[name="passwordShown"]');
    expect(mirror, "the mirror must be addressable by a verified css").toBeDefined();
    expect(mirror!.visible).toBe(false);
    expect(await page.locator(mirror!.css!).count()).toBe(1);
    expect(await page.locator(mirror!.css!).isVisible()).toBe(false);
  });

  it("never names an element by its HTML name attribute", async () => {
    await page.setContent(HTML);
    const els = await enumerateLiveElements(page);
    expect(els.map((e) => e.name)).not.toContain("passwordShown");
    expect(els.map((e) => e.name)).not.toContain("pw");
  });

  it("keeps the real fields on their stable #id, visible", async () => {
    await page.setContent(HTML);
    const els = await enumerateLiveElements(page);
    const real = els.find((e) => e.css === "#password")!;
    expect(real).toMatchObject({ role: "textbox", name: "Password", visible: true, nameSource: "label" });
    expect(els.find((e) => e.css === "#Login")).toMatchObject({ role: "button", name: "Log In", visible: true });
  });
});

describe("accessible name", () => {
  it("follows accname order: aria-labelledby > aria-label > label > placeholder > title", async () => {
    await page.setContent(`
      <span id="lb">From labelledby</span>
      <label for="a">From label A</label>
      <input id="a" aria-labelledby="lb" aria-label="From aria-label" placeholder="ph" title="ti">
      <label for="b">From label B</label>
      <input id="b" aria-label="From aria-label B" placeholder="ph" title="ti">
      <label for="c">From label C</label>
      <input id="c" placeholder="ph C" title="ti">
      <input id="d" placeholder="From placeholder D" title="ti">
      <input id="e" title="From title E">`);
    const els = await enumerateLiveElements(page);
    const at = (css: string) => els.find((e) => e.css === css)!;
    expect(at("#a")).toMatchObject({ name: "From labelledby", nameSource: "aria-labelledby" });
    expect(at("#b")).toMatchObject({ name: "From aria-label B", nameSource: "aria-label" });
    expect(at("#c")).toMatchObject({ name: "From label C", nameSource: "label" });
    expect(at("#d")).toMatchObject({ name: "From placeholder D", nameSource: "placeholder" });
    expect(at("#e")).toMatchObject({ name: "From title E", nameSource: "title" });
  });

  it("uses the placeholder, not the name attribute — the saucedemo shape", async () => {
    await page.setContent(`<input name="user-name" placeholder="Username">`);
    const [el] = await enumerateLiveElements(page);
    expect(el).toMatchObject({ role: "textbox", name: "Username", nameSource: "placeholder" });
  });

  it("never falls back to the name attribute, even when it is the ONLY candidate", async () => {
    // Every other test input has a better source, which would mask a name-attribute fallback.
    await page.setContent(`<input name="user-name"><input name="pass-word" class="form_input">`);
    const els = await enumerateLiveElements(page);
    const names = els.map((e) => e.name);
    expect(names).not.toContain("user-name");
    expect(names).not.toContain("pass-word");
    // The classed one is still addressable, by a DERIVED name (domExtract parity) and its css.
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ name: "form input", nameSource: "derived", css: 'input[name="pass-word"]' });
  });

  it("does not let a <select>'s options leak into a wrapping label's name", async () => {
    await page.setContent(`<label>Country <select><option>India</option><option>Peru</option></select></label>`);
    const [el] = await enumerateLiveElements(page);
    expect(el).toMatchObject({ role: "combobox", name: "Country" });
  });

  it("falls back to proximity text for an anonymous field, and flags it", async () => {
    await page.setContent(`<div>Full Name</div><input class="x">`);
    const [el] = await enumerateLiveElements(page);
    expect(el).toMatchObject({ name: "Full Name", nameFromProximity: true, nameSource: "proximity" });
  });

  it("names a submit input by its value, and never names a textbox by its value", async () => {
    await page.setContent(`<input type="submit" value="Send"><input value="typed by user">`);
    const els = await enumerateLiveElements(page);
    expect(els.find((e) => e.role === "button")).toMatchObject({ name: "Send", nameSource: "value" });
    expect(els.map((e) => e.name)).not.toContain("typed by user");
  });
});

describe("visibility — measured, not assumed", () => {
  it("matches the recheckVisibility predicate, including the position:fixed case", async () => {
    await page.setContent(`
      <button style="position:fixed; top:0">Fixed</button>
      <header style="position:fixed; top:40px"><button>InFixedHeader</button></header>
      <button style="display:none">DisplayNone</button>
      <button style="visibility:hidden">VisHidden</button>
      <button style="opacity:0">Transparent</button>
      <button style="width:0; height:0; padding:0; border:0; overflow:hidden">ZeroSize</button>
      <button>Plain</button>`);
    const els = await enumerateLiveElements(page);
    const vis = (n: string) => byName(els, n)[0]?.visible;
    // offsetParent is null for an element that is ITSELF position:fixed (a child of a fixed
    // header gets the header as its offsetParent, so it would not exercise the trap). Using
    // offsetParent would hide every fixed control.
    expect(vis("Fixed")).toBe(true);
    expect(vis("InFixedHeader")).toBe(true);
    expect(vis("Plain")).toBe(true);
    expect(vis("DisplayNone")).toBe(false);
    expect(vis("VisHidden")).toBe(false);
    expect(vis("Transparent")).toBe(false);
    expect(vis("ZeroSize")).toBe(false);
    for (const e of els) expect(e.visibleSource).toBe("computed");
  });
});

describe("css — present on every element, verified by executing it", () => {
  // Every element carries a unique data-k equal to its expected name, so "the selector resolves
  // to THIS element" is checked by reading data-k back through Playwright. data-k is not on the
  // walker's ladder, so it cannot leak into the selectors under test.
  const HTML = `
    <div id="app">
      <section>
        <button data-k="b1">b1</button>
        <button data-k="b2">b2</button>
        <div><span><a href="/x" data-k="deep">deep</a></span></div>
      </section>
      <section>
        <button data-k="b3">b3</button>
      </section>
    </div>
    <button id="a.b" data-k="dotted id">dotted id</button>
    <button id="1x" data-k="digit id">digit id</button>
    <input name='q"uote' aria-label="quoted name" data-k="quoted name">
    <input aria-label="back\\slash" data-k="back\\slash">
    <ul><li><button data-k="li1">li1</button></li><li><button data-k="li2">li2</button></li></ul>
    <h2 data-k="heading">heading</h2>`;

  it("gives EVERY element a css that matches exactly one element — and the right one", async () => {
    await page.setContent(HTML);
    const els = await enumerateLiveElements(page);
    expect(els.length).toBe(11);
    for (const e of els) {
      expect(e.css, `${e.name} has no css`).toBeTruthy();
      const loc = page.locator(e.css!);
      expect(await loc.count(), `${e.css} for ${e.name}`).toBe(1);
      expect(await loc.getAttribute("data-k"), `${e.css} resolved to the wrong element`).toBe(e.name);
    }
  });

  it("anchors a positional path at the nearest ancestor with a unique id", async () => {
    await page.setContent(HTML);
    const els = await enumerateLiveElements(page);
    expect(byName(els, "deep")[0].css).toBe("#app > section:nth-of-type(1) > div > span > a");
    expect(byName(els, "li2")[0].css).toBe("body > ul > li:nth-of-type(2) > button");
  });

  it("prefers the most stable attribute: data-test > data-testid > data-qa > id > name > aria-label", async () => {
    await page.setContent(`
      <button data-test="t" data-testid="ti" data-qa="q" id="i" name="n" aria-label="A1">x</button>
      <button data-testid="ti2" data-qa="q2" id="i2" aria-label="A2">x</button>
      <button data-qa="q3" id="i3" aria-label="A3">x</button>
      <button id="i4" name="n4" aria-label="A4">x</button>
      <button name="n5" aria-label="A5">x</button>
      <button aria-label="A6">x</button>`);
    const css = (await enumerateLiveElements(page)).map((e) => e.css);
    expect(css).toEqual([
      '[data-test="t"]', '[data-testid="ti2"]', '[data-qa="q3"]', "#i4", 'button[name="n5"]', 'button[aria-label="A6"]',
    ]);
  });

  it("skips a stable attribute that is NOT unique and moves down the ladder", async () => {
    await page.setContent(`
      <button data-testid="dup" id="one">one</button>
      <button data-testid="dup" id="two">two</button>`);
    expect((await enumerateLiveElements(page)).map((e) => e.css)).toEqual(["#one", "#two"]);
  });
});

describe("what the walk includes and excludes", () => {
  it("excludes type=hidden inputs entirely — their value must never become a name (TD-64)", async () => {
    await page.setContent(`<form><input type="hidden" name="csrf" value="SECRET-TOKEN"><button>Go</button></form>`);
    const els = await enumerateLiveElements(page);
    expect(els).toHaveLength(1);
    expect(JSON.stringify(els)).not.toContain("SECRET-TOKEN");
  });

  it("computes enabled from :disabled (including a disabled fieldset) and aria-disabled", async () => {
    await page.setContent(`
      <button disabled>Off</button>
      <fieldset disabled><input aria-label="InFieldset"></fieldset>
      <div role="button" aria-disabled="true">AriaOff</div>
      <button>On</button>`);
    const els = await enumerateLiveElements(page);
    const en = (n: string) => byName(els, n)[0]?.enabled;
    expect(en("Off")).toBe(false);
    expect(en("InFieldset")).toBe(false);
    expect(en("AriaOff")).toBe(false);
    expect(en("On")).toBe(true);
  });

  it("gives role=none / presentation on a non-native element no entry, but keeps a native control", async () => {
    await page.setContent(`<div role="presentation">Decor</div><button role="none">Real</button>`);
    const els = await enumerateLiveElements(page);
    expect(byName(els, "Decor")).toHaveLength(0);
    expect(byName(els, "Real")[0]).toMatchObject({ role: "button" });
  });

  it("returns no FEWER elements per role than the cheerio path on the same page", async () => {
    // The brief's rule for the flag-on diff: more elements is expected, fewer is a bug. Compared
    // per role on a page with no type=hidden inputs (the one deliberate exclusion above).
    await page.setContent(`
      <nav><a href="/a">Alpha</a><a href="/b">Beta</a></nav>
      <h1>Title</h1><h2>Sub</h2>
      <form>
        <label for="e">Email</label><input id="e" type="email">
        <input type="checkbox" aria-label="Remember">
        <select aria-label="Plan"><option>A</option></select>
        <textarea placeholder="Notes"></textarea>
        <button type="submit">Save</button>
      </form>
      <div role="tab">Tab one</div>
      <ul><li><button>Dup</button></li><li><button>Dup</button></li></ul>`);
    const live = await enumerateLiveElements(page);
    const cheerio = (await extractDomModelFromPage(page, "https://example.test/"))!.pages[0].elements;
    const count = (els: Element[]) => els.reduce<Record<string, number>>((m, e) => { m[e.role] = (m[e.role] ?? 0) + 1; return m; }, {});
    const l = count(live);
    for (const [role, n] of Object.entries(count(cheerio))) {
      expect(l[role] ?? 0, `role ${role}: live ${l[role] ?? 0} < cheerio ${n}`).toBeGreaterThanOrEqual(n);
    }
  });
});

/** A page whose `<script>` attaches shadow roots — setContent runs inline scripts. */
const withShadow = (body: string, script: string) => `${body}<script>${script}</script>`;

describe("shadow DOM (open roots)", () => {
  it("enumerates elements inside an open shadow root, each addressable by a verified >> chain", async () => {
    await page.setContent(withShadow(`<div id="h1"></div>`, `
      document.getElementById("h1").attachShadow({ mode: "open" }).innerHTML =
        '<button data-k="Save">Save</button><label for="q">Query</label><input id="q" data-k="Query">';`));
    const els = await enumerateLiveElements(page);
    expect(els.map((e) => e.name)).toEqual(["Save", "Query"]);
    for (const e of els) {
      expect(e.inShadow).toBe(true);
      expect(e.css).toContain(" >> ");
      const loc = page.locator(e.css!);
      expect(await loc.count(), e.css).toBe(1);
      expect(await loc.getAttribute("data-k"), e.css).toBe(e.name);
    }
    // A <label for> inside the shadow tree names the input in the same tree.
    expect(els[1]).toMatchObject({ role: "textbox", nameSource: "label" });
  });

  it("reaches through NESTED shadow roots and through hosts with no stable attribute", async () => {
    await page.setContent(withShadow(`<my-card></my-card><my-card></my-card>`, `
      for (const [i, host] of Array.from(document.querySelectorAll("my-card")).entries()) {
        const outer = host.attachShadow({ mode: "open" });
        outer.innerHTML = '<section></section>';
        outer.querySelector("section").attachShadow({ mode: "open" }).innerHTML =
          '<button data-k="Buy ' + i + '">Buy ' + i + '</button>';
      }`));
    const els = await enumerateLiveElements(page);
    expect(els.map((e) => e.name)).toEqual(["Buy 0", "Buy 1"]);
    for (const e of els) {
      expect(e.css!.split(" >> ")).toHaveLength(3); // host >> section >> button
      expect(await page.locator(e.css!).getAttribute("data-k")).toBe(e.name);
    }
  });

  it("does not give a light element an id Playwright also finds inside a shadow root", async () => {
    // Measured: document.querySelectorAll("#dup") counts 1 here, Playwright counts 2. An in-page
    // check alone would have handed the light button "#dup", and `.first()` would be luck.
    await page.setContent(withShadow(`<button id="dup" data-k="light">light</button><div id="h"></div>`, `
      document.getElementById("h").attachShadow({ mode: "open" }).innerHTML =
        '<button id="dup" data-k="shadow">shadow</button>';`));
    expect(await page.locator("#dup").count()).toBe(2); // the premise, re-measured
    const els = await enumerateLiveElements(page);
    expect(els).toHaveLength(2);
    for (const e of els) {
      expect(e.css).not.toBe("#dup");
      expect(await page.locator(e.css!).count(), e.css).toBe(1);
      expect(await page.locator(e.css!).getAttribute("data-k")).toBe(e.name);
    }
  });

  it("lists elements in getByRole's order, so an IR nth means the same thing to the spec", async () => {
    // Measured on the pinned Playwright, and NOT composed-tree order: all light-DOM matches first
    // (slotted ones included), then each open shadow root's, depth-first over roots — a root nested
    // in h1's shadow (N1) comes before the next host's (S2). A walk that put shadow content at its
    // host's position failed this test.
    await page.setContent(withShadow(`
      <button>L0</button>
      <div id="h1"><button>L1-slotted</button></div>
      <button>L2</button>
      <div id="h2"></div>
      <button>L3</button>`, `
      const s1 = document.getElementById("h1").attachShadow({ mode: "open" });
      s1.innerHTML = '<button>S1a</button><div id="n"></div><slot></slot><button>S1b</button>';
      s1.getElementById("n").attachShadow({ mode: "open" }).innerHTML = '<button>N1</button>';
      document.getElementById("h2").attachShadow({ mode: "open" }).innerHTML = '<button>S2</button>';`));
    const walked = (await enumerateLiveElements(page)).filter((e) => e.role === "button").map((e) => e.name);
    expect(walked).toEqual(await page.getByRole("button").allTextContents());
    expect(walked).toEqual(await page.locator("button").allTextContents());
    expect(walked).toEqual(["L0", "L1-slotted", "L2", "L3", "S1a", "S1b", "N1", "S2"]);
  });

  it("gives identical anonymous controls in one shadow root distinct, working :scope paths", async () => {
    await page.setContent(withShadow(`<div id="h"></div>`, `
      document.getElementById("h").attachShadow({ mode: "open" }).innerHTML =
        '<ul><li><button data-k="0">Dup</button></li><li><button data-k="1">Dup</button></li></ul>';`));
    const els = await enumerateLiveElements(page);
    expect(els).toHaveLength(2);
    expect(els[0].css).not.toBe(els[1].css);
    expect(await page.locator(els[0].css!).getAttribute("data-k")).toBe("0");
    expect(await page.locator(els[1].css!).getAttribute("data-k")).toBe("1");
  });

  it("anchors a shadow positional path at the host with :scope, so it cannot match deeper", async () => {
    // Without the anchor, A's path "div > button" also matches B (inner div > button): Playwright
    // counts 2, verification rejects it, and A is left with no css at all.
    await page.setContent(withShadow(`<div id="h"></div>`, `
      document.getElementById("h").attachShadow({ mode: "open" }).innerHTML =
        '<div><button data-k="A">A</button><div><button data-k="B">B</button></div></div>';`));
    const els = await enumerateLiveElements(page);
    expect(els.map((e) => e.name)).toEqual(["A", "B"]);
    for (const e of els) {
      expect(e.css, `${e.name} has no css`).toBeTruthy();
      expect(await page.locator(e.css!).getAttribute("data-k")).toBe(e.name);
    }
  });

  it("resolves aria-labelledby inside the shadow root, not against the document", async () => {
    await page.setContent(withShadow(`<span id="lbl">Wrong (document)</span><div id="h"></div>`, `
      document.getElementById("h").attachShadow({ mode: "open" }).innerHTML =
        '<span id="lbl">Right (shadow)</span><input aria-labelledby="lbl">';`));
    const [el] = await enumerateLiveElements(page);
    expect(el).toMatchObject({ name: "Right (shadow)", nameSource: "aria-labelledby" });
  });

  it("enumerates slotted content once, as light DOM", async () => {
    await page.setContent(withShadow(`<div id="h"><a href="/x" data-k="Slotted">Slotted</a></div>`, `
      document.getElementById("h").attachShadow({ mode: "open" }).innerHTML = '<slot></slot>';`));
    const els = await enumerateLiveElements(page);
    expect(els).toHaveLength(1);
    expect(els[0].inShadow).toBeUndefined();
    expect(await page.locator(els[0].css!).getAttribute("data-k")).toBe("Slotted");
  });

  it("carries the composed path through the host in genericPath, so landmark tagging still works", async () => {
    await page.setContent(withShadow(`<main><div id="h"></div></main>`, `
      document.getElementById("h").attachShadow({ mode: "open" }).innerHTML = '<button>In main</button>';`));
    const [el] = await enumerateLiveElements(page);
    expect(el.genericPath).toBe("html>body>main>div>button");
  });

  it("skips a CLOSED shadow root's content (unreachable by design) without failing the walk", async () => {
    await page.setContent(withShadow(`<div id="closed"></div><div id="open"></div>`, `
      document.getElementById("closed").attachShadow({ mode: "closed" }).innerHTML = '<button>Hidden away</button>';
      document.getElementById("open").attachShadow({ mode: "open" }).innerHTML = '<button>Reachable</button>';`));
    expect((await enumerateLiveElements(page)).map((e) => e.name)).toEqual(["Reachable"]);
  });

  it("leaves a shadow-free page on the in-page check — no element is flagged inShadow", async () => {
    await page.setContent(`<button id="a">A</button><button>B</button>`);
    const els = await enumerateLiveElements(page);
    expect(els.every((e) => e.inShadow === undefined)).toBe(true);
    expect(els.map((e) => e.css)).toEqual(["#a", "body > button:nth-of-type(2)"]);
  });
});

/**
 * A page on a fake origin with iframes, served by page.route — no network. `pages` maps a path
 * to its HTML; anything on http://other.test is a different origin.
 */
async function framedPage(pages: Record<string, string>): Promise<Page> {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.route("http://app.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    return r.fulfill({ contentType: "text/html", body: pages[path] ?? "<p>404</p>" });
  });
  await p.route("http://other.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<button>Foreign</button>" }));
  await p.goto("http://app.test/");
  // Every frame must have loaded before the walk.
  await p.waitForFunction(() => Array.from(document.querySelectorAll("iframe")).every((f) => {
    // A cross-origin frame's contentDocument is null (not a throw) — nothing to wait for there.
    try { return !f.contentDocument || f.contentDocument.readyState === "complete"; } catch { return true; }
  }));
  await p.waitForTimeout(100);
  return p;
}

describe("same-origin iframes", () => {
  it("tags iframe elements with a frame path that a real frameLocator chain resolves", async () => {
    const p = await framedPage({
      "/": `<button data-k="Top">Top</button><iframe id="f" src="/inner"></iframe>`,
      "/inner": `<label for="e">Email</label><input id="e" data-k="Email"><iframe src="/deep"></iframe>`,
      "/deep": `<button data-k="Deep">Deep</button>`,
    });
    try {
      const els = await enumerateLiveElements(p);
      expect(els.map((e) => [e.name, e.frame])).toEqual([
        ["Top", undefined], ["Email", "#f"], ["Deep", "#f >>> body > iframe"],
      ]);
      for (const e of els) {
        let root: any = p;
        for (const seg of (e.frame ?? "").split(" >>> ").filter(Boolean)) root = root.frameLocator(seg);
        const loc = root.locator(e.css!);
        expect(await loc.count(), `${e.frame} | ${e.css}`).toBe(1);
        expect(await loc.getAttribute("data-k")).toBe(e.name);
      }
    } finally { await p.context().close(); }
  });

  it("skips a cross-origin iframe", async () => {
    const p = await framedPage({ "/": `<button>Mine</button><iframe src="http://other.test/x"></iframe>` });
    try {
      expect((await enumerateLiveElements(p)).map((e) => e.name)).toEqual(["Mine"]);
    } finally { await p.context().close(); }
  });

  it("never treats a data: iframe as same-origin, even under an opaque top origin", async () => {
    // about:blank's origin and a data: frame's are both serialised as "null"; that is not a match.
    await page.setContent(`<button>Mine</button><iframe src="data:text/html,<button>Opaque</button>"></iframe>`);
    await page.waitForTimeout(200);
    expect((await enumerateLiveElements(page)).map((e) => e.name)).toEqual(["Mine"]);
  });

  it("measures visibility inside the frame — a control in a display:none iframe is not visible", async () => {
    const p = await framedPage({
      "/": `<iframe id="shown" src="/a"></iframe><iframe id="gone" style="display:none" src="/b"></iframe>`,
      "/a": `<button>Shown</button>`,
      "/b": `<button>InHiddenFrame</button>`,
    });
    try {
      const els = await enumerateLiveElements(p);
      expect(els.find((e) => e.name === "Shown")).toMatchObject({ visible: true, frame: "#shown" });
      // Either not enumerated at all or enumerated as not visible — never "visible: true".
      const hidden = els.find((e) => e.name === "InHiddenFrame");
      if (hidden) expect(hidden.visible).toBe(false);
    } finally { await p.context().close(); }
  });

  it("reaches an iframe that sits inside an open shadow root", async () => {
    const p = await framedPage({
      "/": `<div id="h"></div><script>
        document.getElementById("h").attachShadow({ mode: "open" }).innerHTML = '<iframe src="/in"></iframe>';
      </script>`,
      "/in": `<button data-k="Framed">Framed</button>`,
    });
    try {
      const [el] = await enumerateLiveElements(p);
      expect(el.name).toBe("Framed");
      expect(el.frame).toContain(" >> "); // the iframe's own selector crosses the shadow boundary
      expect(await p.frameLocator(el.frame!).locator(el.css!).getAttribute("data-k")).toBe("Framed");
    } finally { await p.context().close(); }
  });
});

describe("TD-40: the in-page callback survives the transform the server actually runs under", () => {
  const SRC = fileURLToPath(new URL("../src/stages/liveDomDiscovery.ts", import.meta.url));

  it("contains no inner function or arrow between the <live-walk> markers", () => {
    const src = readFileSync(SRC, "utf8");
    const body = src.slice(src.indexOf("// <live-walk>"), src.indexOf("// </live-walk>"));
    expect(body.length).toBeGreaterThan(1000);
    // Strip comments first: the warning comment itself talks about functions.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bfunction\b/);
    // Exactly one arrow: the evaluate callback itself, which is anonymous (never __name-wrapped).
    expect(code.match(/=>/g) ?? []).toHaveLength(1);
  });

  it("runs under real tsx (esbuild keepNames) in a real browser without ReferenceError", () => {
    // vitest's transform does not inject esbuild's __name helper, so only a real tsx run can
    // reproduce TD-40. This spawns one — the same loader `npm run serve` uses.
    const dir = mkdtempSync(join(tmpdir(), "livewalk-"));
    try {
      const pw = fileURLToPath(new URL("../node_modules/playwright/index.mjs", import.meta.url));
      const script = join(dir, "run.mts");
      writeFileSync(script, `
        import { chromium } from ${JSON.stringify(pw)};
        import { enumerateLiveElements } from ${JSON.stringify(SRC)};
        const b = await chromium.launch();
        try {
          const p = await b.newPage();
          await p.setContent('<label for="u">User</label><input id="u"><div>Near</div><input><button>Go</button>'
            + '<div id="h"></div><script>document.getElementById("h").attachShadow({mode:"open"}).innerHTML = "<button>Deep</button>";</script>');
          console.log(JSON.stringify(await enumerateLiveElements(p)));
        } finally { await b.close(); }
      `);
      const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
      const res = spawnSync(tsx, [script], { encoding: "utf8", env: process.env, timeout: 60_000 });
      expect(res.stderr).not.toContain("__name is not defined");
      expect(res.status, res.stderr).toBe(0);
      const els = JSON.parse(res.stdout.trim().split("\n").pop()!);
      expect(els.map((e: Element) => e.name)).toEqual(["User", "Near", "Go", "Deep"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("raw walk", () => {
  it("is exported for inspection and reports an empty name rather than guessing", async () => {
    await page.setContent(`<input>`);
    const [raw] = await walkLiveDom(page);
    expect(raw).toMatchObject({ role: "textbox", name: "", nameSource: "" });
  });
});
