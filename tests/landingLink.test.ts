import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { app } from "../src/server/index.js";
import { invalidateMemberships } from "../src/server/authz.js";
import { landingUrl } from "../src/server/landingLink.js";

/**
 * D-76 — the two-way link between the standalone landing page (landing/) and the app.
 * Landing -> app is plain hrefs in landing/index.html. App -> landing is LANDING_URL, reported by
 * /api/health and turned into one top-bar link by app.js. Unset means off, and off means the
 * health body and the top bar are exactly what they were before.
 */

const original = process.env.LANDING_URL;
beforeEach(() => {
  delete process.env.AUTH_ENABLED;
  delete process.env.DB_ENABLED;
  delete process.env.LANDING_URL;
  invalidateMemberships();
});
afterEach(() => {
  if (original === undefined) delete process.env.LANDING_URL;
  else process.env.LANDING_URL = original;
});

describe("landingUrl()", () => {
  it("is off when unset or blank", () => {
    expect(landingUrl()).toBeNull();
    process.env.LANDING_URL = "   ";
    expect(landingUrl()).toBeNull();
  });

  it("accepts an https or http address and trims it", () => {
    process.env.LANDING_URL = "  https://testbench.example.com  ";
    expect(landingUrl()).toBe("https://testbench.example.com/");
    process.env.LANDING_URL = "http://localhost:8080/landing/";
    expect(landingUrl()).toBe("http://localhost:8080/landing/");
  });

  it("refuses anything that is not an http(s) address", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.com", "example.com", "not a url"]) {
      process.env.LANDING_URL = bad;
      expect(landingUrl()).toBeNull();
    }
  });
});

describe("GET /api/health and LANDING_URL", () => {
  it("has no landingUrl field when LANDING_URL is unset (flag off)", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect("landingUrl" in res.body).toBe(false);
  });

  it("has no landingUrl field for an unsafe value", async () => {
    process.env.LANDING_URL = "javascript:alert(1)";
    const res = await request(app).get("/api/health");
    expect("landingUrl" in res.body).toBe(false);
  });

  it("reports landingUrl when set, and keeps every existing field", async () => {
    process.env.LANDING_URL = "https://testbench.example.com";
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.landingUrl).toBe("https://testbench.example.com/");
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.defaults.gateReview).toBe("boolean");
    expect(typeof res.body.authEnabled).toBe("boolean");
  });
});

describe("the landing link in app.js", () => {
  // Normalised to LF: a Windows checkout (core.autocrlf) has CRLF line endings, CI does not.
  const APP = readFileSync("public/app.js", "utf8").replace(/\r\n/g, "\n");
  const CSS = readFileSync("public/style.css", "utf8");
  const s = APP.indexOf("function renderLandingLink(");
  const e = APP.indexOf("\n}\n", s);
  const BLOCK = e < 0 ? "" : APP.slice(s, e);

  it("is found (the guards below are not vacuous)", () => {
    expect(s).toBeGreaterThan(0);
    expect(BLOCK).toContain('a.className = "topbar-btn"');
  });

  it("is built only from /api/health's landingUrl", () => {
    expect(APP).toContain('if (h && typeof h.landingUrl === "string") renderLandingLink(h.landingUrl);');
  });

  it("reuses an existing style.css class and never toggles .hidden (rules 3 and 4)", () => {
    expect(CSS).toMatch(/\.topbar-btn\b/);
    expect(BLOCK).not.toContain("hidden");
    expect(BLOCK).not.toContain("innerHTML");
  });

  it("is not hard-coded into index.html any more (off means no link)", () => {
    const HTML = readFileSync("public/index.html", "utf8");
    expect(HTML).not.toContain("landingLink");
    expect(HTML).not.toContain("landing.html");
  });
});

describe("landing/ is a standalone site", () => {
  const PAGE = readFileSync("landing/index.html", "utf8");

  it("loads its own files by relative path, so it works from any host or folder", () => {
    expect(PAGE).toContain('href="landing.css"');
    expect(PAGE).toContain('src="landing.js"');
    expect(PAGE).not.toMatch(/(?:href|src)="\/(?!\/)/);
  });

  it("never loads the app's stylesheet or script", () => {
    const tags = PAGE.match(/<(?:link|script)\s[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).not.toMatch(/style\.css|app\.js|theme\.css/);
  });

  it("is no longer served by the app", () => {
    expect(() => readFileSync("public/landing.html", "utf8")).toThrow();
  });
});
