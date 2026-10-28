import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * D-72 — a project's discovery is saved for 7 days and shared by every run of that project with the
 * same URL and login (PROJECT_DISCOVERY_SHARING). One discovery at a time per key. No browser is
 * opened here: hits come from the real cache, and every miss uses a loopback URL that discovery
 * refuses before it launches anything.
 */

const { projectDiscoveryKey, readOrClaim, PROJECT_DISCOVERY_TTL_MS, _inflightCount } =
  await import("../src/kb/projectDiscovery.js");
const { cacheSet } = await import("../src/kb/cache.js");
const { discoverSiteHybrid, siteCacheKey } = await import("../src/stages/hybridDiscovery.js");

const DIR = path.join("runs", "_cache", "appmodels");
const SITE = "https://shared-discovery.example.test/";
const LOOPBACK = "http://127.0.0.1:9/";
const A = { organisationId: "org-A", projectId: "proj-1" };
const model = (baseUrl: string) => ({
  baseUrl, pages: [{ url: baseUrl, title: "Home", concepts: ["Home"], elements: [{ role: "button", name: "Go" }] }],
});

/** Every cache file this test wrote: they carry one of our two test base URLs. */
afterEach(() => {
  if (!existsSync(DIR)) return;
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(path.join(DIR, f), "utf8"));
      if (m?.baseUrl === SITE || m?.baseUrl === LOOPBACK) rmSync(path.join(DIR, f), { force: true });
    } catch { /* not ours */ }
  }
  vi.restoreAllMocks();
});

function save(scope: typeof A, url: string, ageMs = 0) {
  const key = projectDiscoveryKey(scope, siteCacheKey(url));
  cacheSet(key, model(url) as any);
  if (ageMs) {
    const f = readdirSync(DIR).map((n) => path.join(DIR, n))
      .find((p) => { try { return JSON.parse(readFileSync(p, "utf8")).baseUrl === url; } catch { return false; } });
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(f!, t, t);
  }
}

describe("the key", () => {
  it("is organisation + project in front of the site key (URL + login + strategy)", () => {
    expect(projectDiscoveryKey(A, "site:https://x/")).toBe("project:org-A:proj-1|site:https://x/");
    expect(projectDiscoveryKey({ organisationId: "o", projectId: null }, "k")).toBe("project:o:none|k");
  });

  it("two logins on one URL are two keys (the user chose per-login sharing)", () => {
    const one = siteCacheKey(SITE, { username: "asha", password: "p1" } as any);
    const two = siteCacheKey(SITE, { username: "ravi", password: "p2" } as any);
    expect(projectDiscoveryKey(A, one)).not.toBe(projectDiscoveryKey(A, two));
    expect(one + two).not.toContain("p1"); // the login is hashed, never in the key
  });
});

describe("one discovery at a time per key", () => {
  it("a second run waits for the first, then reads what it saved — no second crawl", async () => {
    let saved: string | null = null;
    const first = await readOrClaim("k1", () => saved);
    expect("release" in first).toBe(true);
    const secondP = readOrClaim("k1", () => saved);
    await new Promise((r) => setTimeout(r, 20));
    let settled = false;
    void secondP.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false); // still waiting on the first
    saved = "the model";
    (first as { release: () => void }).release();
    expect(await secondP).toEqual({ hit: "the model" });
    expect(_inflightCount()).toBe(0);
  });

  it("if the first found nothing to save, exactly ONE waiting run takes over", async () => {
    const first = await readOrClaim("k2", () => null) as { release: () => void };
    const b = readOrClaim("k2", () => null);
    const c = readOrClaim("k2", () => null);
    first.release();
    const rb = await b;
    expect("release" in rb).toBe(true);
    let cDone = false;
    void c.then(() => { cDone = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(cDone).toBe(false); // c waits for b's crawl now
    (rb as { release: () => void }).release();
    const rc = await c;
    (rc as { release: () => void }).release();
    expect(_inflightCount()).toBe(0);
  });
});

describe("discoverSiteHybrid with a project scope", () => {
  it("reuses the project's saved discovery, says so, and opens no browser", async () => {
    save(A, SITE);
    const m = await discoverSiteHybrid(SITE, undefined, undefined, "", false, A);
    expect(m.pages[0].title).toBe("Home");
    expect(m.savedScan).toMatchObject({ reused: true, scope: "project" });
    expect(_inflightCount()).toBe(0);
  });

  it("another company, or another project, does not get it", async () => {
    save(A, LOOPBACK);
    // A miss crawls; the loopback URL is refused before any browser, which proves it was a miss.
    await expect(discoverSiteHybrid(LOOPBACK, undefined, undefined, "", false, { organisationId: "org-B", projectId: "proj-1" }))
      .rejects.toThrow(/private\/loopback/);
    await expect(discoverSiteHybrid(LOOPBACK, undefined, undefined, "", false, { organisationId: "org-A", projectId: "proj-2" }))
      .rejects.toThrow(/private\/loopback/);
    // …and the same scope does.
    expect((await discoverSiteHybrid(LOOPBACK, undefined, undefined, "", false, A)).savedScan?.reused).toBe(true);
    expect(_inflightCount()).toBe(0); // a throwing discovery still released its claim
  });

  it("kept for 7 days: 6 days old is reused, 8 days old is discovered again", async () => {
    save(A, LOOPBACK, 6 * 24 * 3600_000);
    expect((await discoverSiteHybrid(LOOPBACK, undefined, undefined, "", false, A)).savedScan?.reused).toBe(true);
    save(A, LOOPBACK, 8 * 24 * 3600_000);
    await expect(discoverSiteHybrid(LOOPBACK, undefined, undefined, "", false, A)).rejects.toThrow(/private\/loopback/);
    expect(PROJECT_DISCOVERY_TTL_MS).toBe(7 * 24 * 3600_000);
  });

  it("'Explore the site again' (freshDiscovery) ignores the saved one", async () => {
    save(A, LOOPBACK);
    await expect(discoverSiteHybrid(LOOPBACK, undefined, undefined, "", true, A)).rejects.toThrow(/private\/loopback/);
  });

  it("no scope (flag off): the project's entry is not read — today's global cache only", async () => {
    save(A, LOOPBACK);
    await expect(discoverSiteHybrid(LOOPBACK)).rejects.toThrow(/private\/loopback/);
  });
});

describe("the run screen", () => {
  const src = readFileSync("public/app.js", "utf8");
  const start = src.indexOf("function summarize(stage, data) {");
  let depth = 0, end = start;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-new-func
  const summarize = new Function("agoText", `${src.slice(start, end)}\nreturn summarize;`)(() => "2 h ago");
  const pages = [{ url: "u", concepts: ["Home"] }];

  it("says when it reused the project's discovery, and when it saved one", () => {
    expect(summarize("discovery", { pages, savedScan: { at: "x", reused: true, scope: "project" } }))
      .toBe("Used this project's saved discovery from 2 h ago, so the site was not explored again. 1 page — Home. Tick \"Explore the site again\" if it has changed");
    expect(summarize("discovery", { pages, savedScan: { at: "x", reused: false, scope: "project" } }))
      .toBe("Discovered 1 page — Home. Saved for this project, so its next runs can skip this step");
    expect(summarize("discovery", { pages })).toBe("Discovered 1 page — Home");
  });

  it("the box is created only from health, reuses existing classes, and never toggles .hidden", () => {
    expect(src).toMatch(/if \(h && h\.projectDiscovery === true\) renderProjectFreshBox\(\);/);
    const block = src.slice(src.indexOf("function renderProjectFreshBox"), src.indexOf("// Jira, Phase 1"));
    expect(block).toContain('class="lib-check"');
    expect(block).toContain('label.className = "field-label"');
    expect(block).not.toMatch(/classList\.(add|remove|toggle)\(\s*["']hidden["']/);
    // The Pro test pins this exact line; the fresh key is folded into baseOptions above it.
    expect(src).toContain("options: proOptions ? { ...baseOptions, ...proOptions } : baseOptions");
  });
});
