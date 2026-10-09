import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { toElementIndex, pageKey } from "../src/schema/appModel.js";

/**
 * The element index shown to a reviewer editing a case at the gate.
 *
 * Two things matter here and nothing else does: that it shows the SAME set of elements the IR
 * stage will later consider actionable, and that a page's secrets cannot ride along with it.
 */

const page = (over: Record<string, unknown> = {}) => ({
  url: "https://example.com/login",
  title: "Sign in",
  concepts: [],
  elements: [],
  ...over,
} as any);

describe("toElementIndex", () => {
  it("keeps named interactive elements, as role + name", () => {
    const model = { baseUrl: "https://example.com", pages: [page({
      elements: [
        { role: "textbox", name: "Email" },
        { role: "button", name: "Sign In" },
      ],
    })] } as any;

    const [out] = toElementIndex(model);
    expect(out.url).toBe("https://example.com/login");
    expect(out.title).toBe("Sign in");
    expect(out.elements).toEqual([
      { role: "textbox", name: "Email" },
      { role: "button", name: "Sign In" },
    ]);
  });

  /**
   * The security property, tested with the exact shape that motivated it: `hiddenInputNames`'
   * own header records a live CSRF token captured from amazon.in, presented as an ordinary
   * `textbox` whose accessible NAME was its own value.
   */
  it("never emits a hidden input, including a CSRF token named after its own value", () => {
    const token = "hEj/Wh8642+o8zAEP15lt9A5gFAdyyTAqoNqg9Fa9jHD";
    const model = { baseUrl: "https://example.com", pages: [page({
      elements: [
        { role: "button", name: "Sign In" },
        { role: "textbox", name: "anti-csrftoken-a2z" },
        { role: "textbox", name: token },
      ],
      forms: [{
        action: "", method: "POST", id: "", name: "", ariaLabel: "",
        fields: [{
          tag: "input", inputType: "hidden", name: "anti-csrftoken-a2z", placeholder: "",
          label: "", required: false, value: token, options: [], id: "", ariaLabel: "",
        }],
      }],
    })] } as any;

    const [out] = toElementIndex(model);
    expect(out.elements).toEqual([{ role: "button", name: "Sign In" }]);
    expect(JSON.stringify(out)).not.toContain(token);
  });

  it("drops elements discovery marked invisible", () => {
    const model = { baseUrl: "https://example.com", pages: [page({
      elements: [
        { role: "button", name: "Visible", visible: true },
        { role: "button", name: "Hidden", visible: false },
      ],
    })] } as any;
    expect(toElementIndex(model)[0].elements).toEqual([{ role: "button", name: "Visible" }]);
  });

  it("drops unnamed and non-interactive elements, matching what a test can address", () => {
    const model = { baseUrl: "https://example.com", pages: [page({
      elements: [
        { role: "button", name: "" },          // nothing to name it by
        { role: "generic", name: "Wrapper" },  // not interactive
        { role: "link", name: "Sign up" },
      ],
    })] } as any;
    expect(toElementIndex(model)[0].elements).toEqual([{ role: "link", name: "Sign up" }]);
  });

  it("dedupes the same control captured more than once", () => {
    const model = { baseUrl: "https://example.com", pages: [page({
      elements: [
        { role: "link", name: "Home" },
        { role: "link", name: "home" },        // same control, mobile menu copy
        { role: "button", name: "Home" },      // genuinely different: different role
      ],
    })] } as any;
    expect(toElementIndex(model)[0].elements).toEqual([
      { role: "link", name: "Home" },
      { role: "button", name: "Home" },
    ]);
  });

  it("caps a page at 60 so the panel stays readable", () => {
    const model = { baseUrl: "https://example.com", pages: [page({
      elements: Array.from({ length: 200 }, (_, i) => ({ role: "button", name: `B${i}` })),
    })] } as any;
    expect(toElementIndex(model)[0].elements).toHaveLength(60);
  });

  /**
   * The payload contract, asserted structurally rather than trusted. `css`, `id`, `testId` and
   * anything else on `Element` must not reach the browser: the panel has no use for them, and
   * keeping the surface to two fields is the second, independent reason a secret cannot leak.
   */
  it("emits role and name and nothing else", () => {
    const model = { baseUrl: "https://example.com", pages: [page({
      elements: [{
        role: "button", name: "Sign In", css: "#signin-btn", id: "signin-btn",
        testId: "signin", concept: "login-submit", order: 3, path: ["body", "form", "button"],
      }],
    })] } as any;
    const el = toElementIndex(model)[0].elements[0];
    expect(Object.keys(el).sort()).toEqual(["name", "role"]);
  });

  it("handles a model with no pages", () => {
    expect(toElementIndex({ baseUrl: "https://example.com", pages: [] } as any)).toEqual([]);
  });
});

/**
 * `public/app.js` is a classic script and cannot import `pageKey`, so it carries its own copy —
 * the same situation as `formatIrStep`, and the same remedy: extract the browser's copy, run it,
 * and prove the two agree. Without this, a case's `targetUrl` could match a page on the server and
 * miss it in the panel, and the reviewer would silently be shown the wrong page's elements.
 */
describe("gatePageKey in app.js agrees with the server's pageKey", () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function gatePageKey(url)");
  const body = source.slice(start);
  let depth = 0, end = -1;
  for (let i = body.indexOf("{"); i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const extracted = body.slice(0, end);
  // eslint-disable-next-line no-new-func
  const browserKey = new Function(`${extracted}; return gatePageKey;`)() as (u: string) => string;

  it("finds the browser's copy at all (guards this test from silently passing)", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(-1);
  });

  it.each([
    "https://example.com",
    "https://example.com/",
    "https://example.com/login",
    "https://example.com/login/",
    "https://example.com/login?next=%2Fdashboard",
    "https://example.com/login#top",
    "https://example.com:8443/login",
    "http://example.com/login",
    "https://www.example.com/login",
    "https://EXAMPLE.com/Login",
    "not a url at all",
  ])("agrees on %s", (url) => {
    expect(browserKey(url)).toBe(pageKey(url));
  });

  it("treats an http case target and the https page discovery recorded as one page (LS-3)", () => {
    expect(browserKey("http://example.com/dashboard")).toBe(browserKey("https://www.example.com/dashboard/"));
  });
});
