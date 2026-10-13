import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `gemini()`'s optional document input (`fileBase64`/`fileMime`), added for Pro intake.
 *
 * Asserts the request BODY actually sent to fetch, so the wire format is checked, not the option
 * name: a file must become the same `inline_data` part an image does, and a call that sets neither
 * must send exactly the single text part it always has.
 */

const ORIGINAL_KEYS = process.env.GEMINI_API_KEYS;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  process.env.GEMINI_API_KEYS = "test-key";
  fetchSpy = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: "{}" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }),
  }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  if (ORIGINAL_KEYS === undefined) delete process.env.GEMINI_API_KEYS;
  else process.env.GEMINI_API_KEYS = ORIGINAL_KEYS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sentParts = () => JSON.parse(fetchSpy.mock.calls[0][1].body).contents[0].parts;

describe("gemini() file input", () => {
  it("sends a file as an inline_data part with its own MIME type", async () => {
    const { gemini } = await import("../src/llm/gemini.js");
    await gemini("distil this", { fileBase64: "JVBERi0=", fileMime: "application/pdf", maxOutputTokens: 8192 });
    expect(sentParts()).toEqual([
      { text: "distil this" },
      { inline_data: { mime_type: "application/pdf", data: "JVBERi0=" } },
    ]);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).generationConfig.maxOutputTokens).toBe(8192);
  });

  it("a call with neither images nor files sends exactly one text part, as before", async () => {
    const { gemini } = await import("../src/llm/gemini.js");
    await gemini("plain");
    expect(sentParts()).toEqual([{ text: "plain" }]);
  });

  it("the image path is unchanged — still defaults to image/png", async () => {
    const { gemini } = await import("../src/llm/gemini.js");
    await gemini("look", { imageBase64: "iVBOR" });
    expect(sentParts()).toEqual([{ text: "look" }, { inline_data: { mime_type: "image/png", data: "iVBOR" } }]);
  });

  it("a file with no MIME type is refused before anything is sent", async () => {
    const { gemini } = await import("../src/llm/gemini.js");
    await expect(gemini("x", { fileBase64: "JVBERi0=" })).rejects.toThrow(/explicit fileMime/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
