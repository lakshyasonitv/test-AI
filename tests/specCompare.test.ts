import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SpecModel } from "../src/schema/spec.js";
import type { AppModel } from "../src/schema/appModel.js";

/**
 * The spec-vs-application comparison: which model runs it, and the deterministic reference check
 * behind its warnings. The model is mocked at the provider layer; the cache is an in-memory map.
 */

const { geminiMock, azureMock, cache } = vi.hoisted(() => ({
  geminiMock: vi.fn(), azureMock: vi.fn(), cache: new Map<string, unknown>(),
}));
vi.mock("../src/llm/gemini.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/gemini.js")>()),
  gemini: geminiMock,
}));
vi.mock("../src/llm/azureOpenAI.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/azureOpenAI.js")>()),
  azureOpenAI: azureMock,
}));
vi.mock("../src/kb/llmCache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kb/llmCache.js")>()),
  llmCacheGet: (k: string, ns = "llm") => (cache.get(`${ns}/${k}`) as any) ?? null,
  llmCacheSet: (k: string, d: unknown, ns = "llm") => { cache.set(`${ns}/${k}`, d); },
}));

const { compareSpecToApp, runSpecComparison, getRunSpecWarnings, SPEC_COMPARE_SYSTEM } =
  await import("../src/stages/specIntake.js");

const SPEC: SpecModel = {
  actors: [], entities: [], actions: [],
  rules: ["A Lead cannot convert without a phone number.", "Only a Manager may reassign."],
  criteria: [], outOfScope: [], unresolved: [], answers: [],
};
const APP: AppModel = {
  baseUrl: "https://crm.example",
  pages: [
    { url: "https://crm.example/leads", title: "Leads", concepts: ["Leads"], elements: [{ role: "button", name: "Convert" }] },
    { url: "https://crm.example/reports", title: "Reports", concepts: ["Reports"], elements: [] },
  ],
};
const gaps = (g: unknown[]) => ({ content: JSON.stringify({ gaps: g }), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });

const ENV = ["LLM_PROVIDER", "LLM_PROVIDER_LITE", "GEMINI_MODEL", "GEMINI_MODEL_LITE", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_DEPLOYMENT_LITE"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.GEMINI_MODEL = "gemini-main";
  process.env.GEMINI_MODEL_LITE = "gemini-lite";
  cache.clear();
  geminiMock.mockReset(); azureMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.restoreAllMocks();
});

describe("which model runs the comparison", () => {
  it("the LITE model, through llm() — not pinned to Gemini's main model", async () => {
    geminiMock.mockResolvedValueOnce(gaps([]));
    await compareSpecToApp(SPEC, APP);
    const [, opts] = geminiMock.mock.calls[0];
    expect(opts.model).toBe("gemini-lite");
    expect(opts.stage).toBe("spec_compare");
    expect(opts.systemInstruction).toBe(SPEC_COMPARE_SYSTEM);
  });

  it("follows LLM_PROVIDER: under azure it goes to Azure's lite deployment, never to Gemini", async () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "main";
    process.env.AZURE_OPENAI_DEPLOYMENT_LITE = "lite";
    azureMock.mockResolvedValueOnce({ ...gaps([]), finishReason: "stop" });
    await compareSpecToApp(SPEC, APP);
    expect(geminiMock).not.toHaveBeenCalled();
    expect(azureMock).toHaveBeenCalledTimes(1);
  });
});

describe("every warning must point at something that exists", () => {
  it("keeps a warning whose rule number and page URL are real; drops invented ones", async () => {
    geminiMock.mockResolvedValueOnce(gaps([
      { kind: "untestable_rule", rule: 1, message: "A rule about the phone number can't be tested — no phone field." },
      { kind: "untestable_rule", rule: 7, message: "Rule seven, which does not exist." },
      { kind: "untestable_rule", message: "No rule number at all." },
      { kind: "unmentioned", url: "https://crm.example/reports", message: "The Reports page isn't covered by the document." },
      { kind: "unmentioned", url: "https://crm.example/invented", message: "A page discovery never found." },
      { kind: "something_else", message: "An unknown kind." },
      "not even an object",
    ]));
    expect(await compareSpecToApp(SPEC, APP)).toEqual([
      "A rule about the phone number can't be tested — no phone field.",
      "The Reports page isn't covered by the document.",
    ]);
  });

  it("dedups, trims, and caps the count", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: "unmentioned", url: "https://crm.example/reports", message: `  Gap   ${i}  ` }));
    geminiMock.mockResolvedValueOnce(gaps([...many, many[0]]));
    const out = await compareSpecToApp(SPEC, APP);
    expect(out).toHaveLength(20);
    expect(out[0]).toBe("Gap 0");
  });

  it("a spec with no rules and no criteria is not sent at all", async () => {
    expect(await compareSpecToApp({ ...SPEC, rules: [] }, APP)).toEqual([]);
    expect(geminiMock).not.toHaveBeenCalled();
  });
});

describe("runSpecComparison never throws", () => {
  it("a provider failure leaves an empty, finished warning list — and logs, never throws", async () => {
    geminiMock.mockRejectedValueOnce(new Error("Gemini 503"));
    await expect(runSpecComparison("2026-10-13T00-00-00-000Z-c0ffee01", SPEC, APP)).resolves.toBeUndefined();
    expect(getRunSpecWarnings("2026-10-13T00-00-00-000Z-c0ffee01")).toEqual({ warnings: [], done: true });
  });

  it("unparseable output is the same: no warnings, done, no throw", async () => {
    geminiMock.mockResolvedValueOnce({ content: "{{{", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    await runSpecComparison("2026-10-13T00-00-00-000Z-c0ffee02", SPEC, APP);
    expect(getRunSpecWarnings("2026-10-13T00-00-00-000Z-c0ffee02")).toEqual({ warnings: [], done: true });
  });
});
