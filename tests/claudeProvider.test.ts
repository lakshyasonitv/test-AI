import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * D-66: the Claude provider. The Anthropic SDK is mocked — no network call, no key, no cost.
 * Proves: the mode switch (LLM_PROVIDER=claude) routes to claude(), unset still means gemini,
 * the cache key names the provider and model, the request body never carries temperature or a
 * literal key, and refusal / truncation / rate-limit map to the shapes backoff.ts already handles.
 */

const create = vi.fn();
const ctorArgs: any[] = [];

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    constructor(public status: number | undefined, public headers?: Headers) { super(`status ${status}`); }
  }
  class APIConnectionError extends APIError {}
  class APIUserAbortError extends APIError {}
  class Anthropic {
    static APIError = APIError;
    static APIConnectionError = APIConnectionError;
    static APIUserAbortError = APIUserAbortError;
    messages = { create };
    constructor(opts: any) { ctorArgs.push(opts); }
  }
  return { default: Anthropic };
});

vi.mock("../src/llm/gemini.js", () => ({
  gemini: vi.fn(async () => ({ content: "gemini", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })),
}));

const { llm, providerFor, cacheModelDimension, modelFor } = await import("../src/llm/client.js");
const { llmCacheDimension } = await import("../src/llm/llmContext.js");
const { claude, resetClaudePoolForTests } = await import("../src/llm/claude.js");
const { findInvalidProviderEnv } = await import("../src/server/index.js");
const { gemini } = await import("../src/llm/gemini.js");
const Anthropic = (await import("@anthropic-ai/sdk")).default as any;

const reply = (text: string, stop = "end_turn") => ({
  content: [{ type: "text", text }],
  stop_reason: stop,
  usage: { input_tokens: 10, output_tokens: 5 },
});

beforeEach(() => {
  for (const v of ["LLM_PROVIDER", "LLM_PROVIDER_LITE", "ANTHROPIC_MODEL", "ANTHROPIC_MODEL_LITE",
    "ANTHROPIC_EFFORT", "ANTHROPIC_EFFORT_LITE", "ANTHROPIC_API_KEYS"]) delete process.env[v];
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  resetClaudePoolForTests();
  create.mockReset();
  ctorArgs.length = 0;
  vi.mocked(gemini).mockClear();
});

describe("the provider mode switch", () => {
  it("unset LLM_PROVIDER still means gemini — Claude is never called", async () => {
    await llm("hi", { role: "main" });
    expect(gemini).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("LLM_PROVIDER=claude routes both roles to Claude", async () => {
    process.env.LLM_PROVIDER = "claude";
    create.mockResolvedValue(reply("ok"));
    expect(providerFor("main")).toBe("claude");
    expect(providerFor("lite")).toBe("claude");
    const r = await llm("hi", { role: "main" });
    expect(r.content).toBe("ok");
    expect(gemini).not.toHaveBeenCalled();
  });

  it("LLM_PROVIDER_LITE can keep the cheap stages on another provider", async () => {
    process.env.LLM_PROVIDER = "claude";
    process.env.LLM_PROVIDER_LITE = "gemini";
    expect(providerFor("lite")).toBe("gemini");
    await llm("hi", { role: "lite" });
    expect(gemini).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("the startup guard accepts claude and still rejects typos", () => {
    expect(findInvalidProviderEnv({ LLM_PROVIDER: "claude" })).toEqual([]);
    expect(findInvalidProviderEnv({ LLM_PROVIDER: "Claude" })).toEqual([{ name: "LLM_PROVIDER", found: "Claude" }]);
    expect(findInvalidProviderEnv({ LLM_PROVIDER_LITE: "anthropic" })).toHaveLength(1);
  });
});

describe("cache key and model", () => {
  it("names the provider and default model", () => {
    process.env.LLM_PROVIDER = "claude";
    expect(modelFor("main")).toBe("claude-opus-5-5");
    expect(cacheModelDimension("main")).toBe("claude:claude-opus-5-5");
    expect(llmCacheDimension("main")).toBe("claude:env");
  });

  it("ANTHROPIC_MODEL_LITE overrides lite only; lite falls back to ANTHROPIC_MODEL", () => {
    process.env.LLM_PROVIDER = "claude";
    process.env.ANTHROPIC_MODEL = "claude-sonnet-5-5";
    expect(cacheModelDimension("lite")).toBe("claude:claude-sonnet-5-5");
    process.env.ANTHROPIC_MODEL_LITE = "claude-haiku-5-5";
    expect(cacheModelDimension("lite")).toBe("claude:claude-haiku-5-5");
    expect(cacheModelDimension("main")).toBe("claude:claude-sonnet-5-5");
  });
});

describe("the request claude() sends", () => {
  it("never sends temperature, sends effort only when set, and takes the key from env", async () => {
    process.env.LLM_PROVIDER = "claude";
    create.mockResolvedValue(reply("ok"));
    await llm("hi", { role: "main", temperature: 0.2, systemInstruction: "sys" });
    let params = create.mock.calls[0][0];
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("output_config");
    expect(params.system).toBe("sys");
    expect(params.model).toBe("claude-opus-5-5");
    expect(ctorArgs[0]).toEqual({ apiKey: "test-key-not-real", maxRetries: 0 });

    process.env.ANTHROPIC_EFFORT = "high";
    await llm("hi", { role: "main" });
    params = create.mock.calls[1][0];
    expect(params.output_config).toEqual({ effort: "high" });
  });

  it("lite never inherits the main effort", async () => {
    process.env.LLM_PROVIDER = "claude";
    process.env.ANTHROPIC_EFFORT = "high";
    create.mockResolvedValue(reply("ok"));
    await llm("hi", { role: "lite" });
    expect(create.mock.calls[0][0]).not.toHaveProperty("output_config");
  });

  it("json adds an instruction; image and PDF become content blocks before the text", async () => {
    create.mockResolvedValue(reply("[1]"));
    await claude("p", { model: "m", json: true, imageBase64: "AAA", fileBase64: "BBB" });
    const params = create.mock.calls[0][0];
    expect(params.system).toMatch(/valid JSON only/);
    expect(params.messages[0].content.map((b: any) => b.type)).toEqual(["document", "image", "text"]);
  });

  it("joins text blocks and reports usage", async () => {
    create.mockResolvedValue({
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: "a" }, { type: "text", text: "b" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 4 },
    });
    const r = await claude("p", { model: "m" });
    expect(r.content).toBe("ab");
    expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 4, totalTokens: 9 });
  });
});

describe("failures map to what backoff.ts already handles", () => {
  it("refusal and max_tokens throw once, without retrying", async () => {
    create.mockResolvedValue(reply("", "refusal"));
    await expect(claude("p", { model: "m" })).rejects.toThrow(/Claude refusal/);
    expect(create).toHaveBeenCalledTimes(1);
    create.mockReset();
    create.mockResolvedValue(reply("partial", "max_tokens"));
    await expect(claude("p", { model: "m" })).rejects.toThrow(/Claude truncated/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a 400 is thrown straight through; a 429 is retried", async () => {
    create.mockRejectedValueOnce(new Anthropic.APIError(400));
    await expect(claude("p", { model: "m" })).rejects.toMatchObject({ status: 400 });
    expect(create).toHaveBeenCalledTimes(1);

    create.mockReset();
    create
      .mockRejectedValueOnce(new Anthropic.APIError(429, new Headers({ "retry-after": "0.01" })))
      .mockResolvedValueOnce(reply("ok"));
    const r = await claude("p", { model: "m" });
    expect(r.content).toBe("ok");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("refuses to run without a model or without a key", async () => {
    await expect(claude("p", {})).rejects.toThrow(/ANTHROPIC_MODEL/);
    delete process.env.ANTHROPIC_API_KEY;
    resetClaudePoolForTests();
    await expect(claude("p", { model: "m" })).rejects.toThrow(/no API keys/);
    expect(create).not.toHaveBeenCalled();
  });
});
