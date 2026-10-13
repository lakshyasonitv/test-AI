import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Pro intake, stage 2: the ONE distillation call and its cache (Pro test 14, and the key's
 * dimensions).
 *
 * `gemini()` is mocked — this checks what the stage SENDS and how it caches, not the model. The
 * cache is replaced by an in-memory map that records the namespace, so nothing touches
 * `runs/_cache` and the "spec" namespace is asserted directly.
 */

const { geminiMock, store, keyCalls } = vi.hoisted(() => ({
  geminiMock: vi.fn(),
  store: new Map<string, unknown>(),
  keyCalls: [] as string[][],
}));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));
vi.mock("../src/kb/llmCache.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/kb/llmCache.js")>();
  return {
    ...real,
    llmCacheGet: (key: string, ns = "llm") => (store.get(`${ns}/${key}`) as any) ?? null,
    llmCacheSet: (key: string, data: unknown, ns = "llm") => { store.set(`${ns}/${key}`, data); },
    makeCacheKey: (...parts: string[]) => { keyCalls.push(parts); return real.makeCacheKey(...parts); },
  };
});

const {
  distillSpec, checkSpecUpload, SPEC_DISTILL_SYSTEM, SPEC_WARNINGS, DISTILL_FAILED_WARNING, SPEC_CACHE_NS,
} = await import("../src/stages/specIntake.js");

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n", "latin1");
const DOCX = readFileSync(path.join(__dirname, "fixtures", "proIntake", "minimal.docx"));
const MD = Buffer.from("# Leads\nA Lead cannot convert without a phone number.\n", "utf8");

const answer = (o: object) => ({
  content: JSON.stringify(o),
  usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
});
const GOOD = { rules: ["A Lead cannot convert without a phone number."], unresolved: ["Which currency?"] };

async function checked(bytes: Buffer, name: string) {
  const c = await checkSpecUpload(bytes, name);
  if (!c.ok) throw new Error(`fixture rejected: ${c.warning}`);
  return c;
}

const ENV_KEYS = ["GEMINI_MODEL", "LLM_CACHE_VERSION", "LLM_PROVIDER", "SPEC_DISTILL_MAX_OUTPUT_TOKENS"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GEMINI_MODEL = "gemini-distill-test";
  store.clear();
  keyCalls.length = 0;
  geminiMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("what distillation sends", () => {
  it("a PDF goes to Gemini as an inline application/pdf file part — never parsed, never in the prompt text", async () => {
    geminiMock.mockResolvedValueOnce(answer(GOOD));
    const r = await distillSpec(PDF, await checked(PDF, "spec.pdf"));
    expect(r.ok).toBe(true);
    const [prompt, opts] = geminiMock.mock.calls[0];
    expect(opts.fileBase64).toBe(PDF.toString("base64"));
    expect(opts.fileMime).toBe("application/pdf");
    expect(opts.imageBase64).toBeUndefined();
    expect(prompt).not.toContain("%PDF");
    expect(opts).toMatchObject({
      systemInstruction: SPEC_DISTILL_SYSTEM, model: "gemini-distill-test", json: true,
      maxOutputTokens: 8192, stage: "spec_intake",
    });
  });

  it("Markdown and DOCX go as text in the prompt, with no file part", async () => {
    geminiMock.mockResolvedValue(answer(GOOD));
    await distillSpec(MD, await checked(MD, "spec.md"));
    await distillSpec(DOCX, await checked(DOCX, "spec.docx"));
    const [mdPrompt, mdOpts] = geminiMock.mock.calls[0];
    const [docxPrompt, docxOpts] = geminiMock.mock.calls[1];
    expect(mdPrompt).toContain("A Lead cannot convert without a phone number.");
    expect(docxPrompt).toContain("Only a Manager may reassign a Lead.");
    expect(mdOpts.fileBase64).toBeUndefined();
    expect(docxOpts.fileBase64).toBeUndefined();
  });

  it("honours the configured output cap", async () => {
    process.env.SPEC_DISTILL_MAX_OUTPUT_TOKENS = "12000";
    geminiMock.mockResolvedValueOnce(answer(GOOD));
    await distillSpec(MD, await checked(MD, "spec.md"));
    expect(geminiMock.mock.calls[0][1].maxOutputTokens).toBe(12000);
  });

  it("is pinned to Gemini even when the pipeline's provider is Azure", async () => {
    process.env.LLM_PROVIDER = "azure";
    geminiMock.mockResolvedValueOnce(answer(GOOD));
    expect((await distillSpec(MD, await checked(MD, "spec.md"))).ok).toBe(true);
    expect(geminiMock).toHaveBeenCalledTimes(1);
  });
});

describe("what distillation returns", () => {
  it("14 unresolved questions from the model arrive as 10", async () => {
    const fourteen = Array.from({ length: 14 }, (_, i) => `Q${i + 1}?`);
    geminiMock.mockResolvedValueOnce(answer({ ...GOOD, unresolved: fourteen }));
    const r = await distillSpec(MD, await checked(MD, "spec.md"));
    expect(r.ok && r.spec.unresolved).toEqual(fourteen.slice(0, 10));
  });

  it("an all-empty answer is the 'may be a scan' warning — and is NOT cached", async () => {
    geminiMock.mockResolvedValue(answer({}));
    const c = await checked(PDF, "scan.pdf");
    expect(await distillSpec(PDF, c)).toEqual({ ok: false, warning: SPEC_WARNINGS.noText });
    expect(store.size).toBe(0);
    await distillSpec(PDF, c);
    expect(geminiMock).toHaveBeenCalledTimes(2); // asked again, not served a cached nothing
  });

  it("retries once on an unusable answer, then succeeds", async () => {
    geminiMock.mockResolvedValueOnce({ content: "not json", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })
      .mockResolvedValueOnce(answer(GOOD));
    const r = await distillSpec(MD, await checked(MD, "spec.md"));
    expect(r.ok).toBe(true);
    expect(geminiMock).toHaveBeenCalledTimes(2);
  });

  it("two unusable answers give a plain warning, never a throw, and nothing is cached", async () => {
    geminiMock.mockResolvedValue({ content: "[1,2", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    expect(await distillSpec(MD, await checked(MD, "spec.md"))).toEqual({ ok: false, warning: DISTILL_FAILED_WARNING });
    expect(geminiMock).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });
});

describe("the cache (test 14)", () => {
  it("a second upload of the identical document makes ZERO LLM calls", async () => {
    geminiMock.mockResolvedValueOnce(answer(GOOD));
    const c = await checked(PDF, "spec.pdf");
    const first = await distillSpec(PDF, c);
    geminiMock.mockClear();
    const second = await distillSpec(PDF, c);
    expect(geminiMock).not.toHaveBeenCalled();
    expect(second).toEqual({ ok: true, spec: (first as any).spec, cached: true });
  });

  it("lives in the 'spec' namespace, and holds only the distilled spec — never the document", async () => {
    geminiMock.mockResolvedValueOnce(answer(GOOD));
    await distillSpec(PDF, await checked(PDF, "spec.pdf"));
    expect(SPEC_CACHE_NS).toBe("spec");
    expect([...store.keys()].every((k) => k.startsWith("spec/"))).toBe(true);
    const stored = JSON.stringify([...store.values()]);
    expect(stored).not.toContain(PDF.toString("base64"));
    expect(stored).not.toContain("%PDF");
  });

  it("the key carries the instruction TEXT, not a version number (D-10), and the global salt", async () => {
    geminiMock.mockResolvedValueOnce(answer(GOOD));
    await distillSpec(MD, await checked(MD, "spec.md"));
    const parts = keyCalls[0];
    expect(parts).toContain(SPEC_DISTILL_SYSTEM);
    expect(parts).toContain("gemini");
    expect(parts).toContain("gemini-distill-test");
    expect(parts).toContain("gemini:env");
    expect(parts[parts.length - 1]).toBe("1"); // llmCacheVersion() default
  });

  it("a different document, model or cache version each misses the cache", async () => {
    geminiMock.mockResolvedValue(answer(GOOD));
    await distillSpec(MD, await checked(MD, "spec.md"));
    expect(geminiMock).toHaveBeenCalledTimes(1);

    const other = Buffer.from("# Leads\nA Lead needs an email address.\n", "utf8");
    await distillSpec(other, await checked(other, "spec.md"));
    expect(geminiMock).toHaveBeenCalledTimes(2);

    process.env.GEMINI_MODEL = "gemini-other-model";
    await distillSpec(MD, await checked(MD, "spec.md"));
    expect(geminiMock).toHaveBeenCalledTimes(3);

    process.env.GEMINI_MODEL = "gemini-distill-test";
    process.env.LLM_CACHE_VERSION = "2";
    await distillSpec(MD, await checked(MD, "spec.md"));
    expect(geminiMock).toHaveBeenCalledTimes(4);

    process.env.LLM_CACHE_VERSION = "1";
    await distillSpec(MD, await checked(MD, "spec.md"));
    expect(geminiMock).toHaveBeenCalledTimes(4); // back to the first key: a hit
  });

  it("the filename is not part of the key — a renamed copy of the same bytes is a hit", async () => {
    geminiMock.mockResolvedValueOnce(answer(GOOD));
    await distillSpec(MD, await checked(MD, "v1.md"));
    await distillSpec(MD, await checked(MD, "renamed-v2.md"));
    expect(geminiMock).toHaveBeenCalledTimes(1);
  });
});
