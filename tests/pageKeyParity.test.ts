import { describe, it, expect } from "vitest";
import { pageKey as schemaPageKey, toMicroModel } from "../src/schema/appModel.js";
import { pageKey as textPageKey } from "../src/text.js";

/**
 * LS-3: `pageKey` existed twice — host + path in `src/text.ts` (the TD-82 fix), origin + path in
 * `src/schema/appModel.ts` — with a comment claiming they matched. They did not, and
 * `toMicroModel`, the schema copy's caller, then sent the model the WRONG page whenever the URL it
 * was handed differed from the recorded one only by scheme or `www.`.
 */
describe("pageKey has ONE definition (LS-3)", () => {
  it("the schema's pageKey IS text.ts's — the same function, so they cannot drift again", () => {
    expect(schemaPageKey).toBe(textPageKey);
  });

  it.each([
    ["http://example.com/login", "https://example.com/login"],
    ["https://www.example.com/a/", "https://example.com/a"],
    ["https://example.com:8443/a?x=1#h", "https://example.com/a"],
  ])("%s and %s are the same page", (a, b) => {
    expect(schemaPageKey(a)).toBe(schemaPageKey(b));
  });

  it("toMicroModel picks the recorded https page for an http current URL — not the first page", () => {
    const model: any = {
      baseUrl: "http://example.com",
      pages: [
        { url: "https://example.com/", title: "Home", concepts: [], elements: [] },
        { url: "https://example.com/dashboard", title: "Dash", concepts: [], elements: [] },
      ],
    };
    const micro = toMicroModel(model, { currentPageUrl: "http://example.com/dashboard" });
    expect(micro.pages.map((p) => p.url)).toEqual(["https://example.com/dashboard"]);
  });
});
