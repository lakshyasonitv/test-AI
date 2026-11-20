import { describe, it, expect, afterEach } from "vitest";
import { AppModel } from "../src/schema/appModel.js";
import { IR } from "../src/schema/ir.js";
import { groundingError, screenBoundaries, trackPages, screenModeAllSites } from "../src/stages/ir.js";

// D-85 (SCREEN_MODE_ALL_SITES). The shape of run 2026-11-17T07-29-08-639Z-b4c58d1e on eventrix.tech:
// the sidebar link "Create Event" leads to /events/create, a page the 5-page crawl never reached, and
// the steps after it named controls that /home ALSO happens to have ("Conference" filter chip, the
// "Filter by title, topic, or city..." search box). Flag off, they ground on /home — the shipped test
// filled /home's search box on a page it had already left.

const BASE = "https://www.eventrix.tech";
const home = {
  url: `${BASE}/home`, title: "Eventrix", concepts: [],
  elements: [
    { role: "link", name: "Create Event", visible: true },
    { role: "button", name: "Conference", visible: true },
    { role: "textbox", name: "Filter by title, topic, or city...", visible: true },
  ],
  domLinks: [{ text: "Create Event", href: `${BASE}/events/create`, isExternal: false, role: "link" }],
};
const model = () => AppModel.parse({ baseUrl: BASE, pages: [home] });
const ir = () => IR.parse({
  meta: { feature: "Events", title: "Create an event", priority: "high", sourcePrompt: "create an event", baseUrl: BASE },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/home" } },
    { id: "s2", action: "click", target: { role: "link", name: "Create Event" } },
    { id: "s3", action: "click", target: { role: "button", name: "Conference" } },
    { id: "s4", action: "fill", target: { role: "textbox", name: "Filter by title, topic, or city..." }, value: "My event" },
  ],
});

afterEach(() => { delete process.env.SCREEN_MODE_ALL_SITES; });

describe("SCREEN_MODE_ALL_SITES off (default): unchanged", () => {
  it("is off unless set to exactly 'true'", () => {
    expect(screenModeAllSites()).toBe(false);
    process.env.SCREEN_MODE_ALL_SITES = "1";
    expect(screenModeAllSites()).toBe(false);
  });

  it("the trail stays on /home after a link to an unmodelled page, as before", () => {
    const trail = trackPages(ir(), model());
    expect(trail.pageAt[2]?.url).toBe(`${BASE}/home`);
  });

  it("link clicks are not screen boundaries, as before", () => {
    expect(screenBoundaries(ir())).toEqual([3]);
  });

  it("the steps after the link still ground on /home's chrome (the bug the flag exists for)", () => {
    expect(groundingError(ir(), model())).toBeNull();
  });
});

describe("SCREEN_MODE_ALL_SITES on", () => {
  it("a link to a page the model never saw leaves the trail unknown, not on the page it left", () => {
    process.env.SCREEN_MODE_ALL_SITES = "true";
    const trail = trackPages(ir(), model());
    expect(trail.pageAt[1]?.url).toBe(`${BASE}/home`);
    expect(trail.pageAt[2]).toBeNull();
    expect(trail.lastLinkHrefAt[2]).toBe(`${BASE}/events/create`);
  });

  it("a link to a page the model DOES have still moves the trail there", () => {
    process.env.SCREEN_MODE_ALL_SITES = "true";
    const create = { url: `${BASE}/events/create`, title: "Create", concepts: [], elements: [{ role: "button", name: "Technical Conferences", visible: true }] };
    const trail = trackPages(ir(), AppModel.parse({ baseUrl: BASE, pages: [home, create] }));
    expect(trail.pageAt[2]?.url).toBe(`${BASE}/events/create`);
  });

  it("the step after a link click is a screen boundary", () => {
    process.env.SCREEN_MODE_ALL_SITES = "true";
    expect(screenBoundaries(ir())).toEqual([2, 3]);
  });

  it("with screen scope, the step after the link asks for a capture instead of grounding on /home", () => {
    process.env.SCREEN_MODE_ALL_SITES = "true";
    const err = groundingError(ir(), model(), { screenAt: [], captureBefore: new Set(screenBoundaries(ir())) });
    expect(err?.index).toBe(2);
    expect(err?.kind).toBe("screen-uncaptured");
  });
});
