import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/llm/gemini.js", () => ({
  gemini: vi.fn(async () => ({
    content: "gemini responded",
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  })),
}));

vi.mock("../src/llm/azureOpenAI.js", () => ({
  azureOpenAI: vi.fn(async () => ({
    content: "azure responded",
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  })),
}));

import { llm, providerFor, cacheModelDimension } from "../src/llm/client.js";
import { llmCacheDimension } from "../src/llm/llmContext.js";
import { gemini } from "../src/llm/gemini.js";
import { azureOpenAI } from "../src/llm/azureOpenAI.js";

/**
 * Structural tests for the provider-selection and caching layer: role resolves to a provider,
 * `cacheModelDimension` names it, `llm()` delegates to exactly the right function.
 * No real Gemini or Azure calls are made — `gemini` and `azureOpenAI` are fully mocked.
 *
 * The provider-delegation test proves D-01 (no fallback), D-02 (structural role→provider check),
 * and the 08-llm-usage.json design (per-stage provider label for non-expiring cost lines).
 */

beforeEach(() => {
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_PROVIDER_LITE;
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_MODEL_LITE;
  delete process.env.AZURE_OPENAI_DEPLOYMENT;
  delete process.env.AZURE_OPENAI_DEPLOYMENT_LITE;
  delete process.env.AZURE_OPENAI_REASONING_EFFORT;
  delete process.env.AZURE_OPENAI_REASONING_EFFORT_LITE;
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_PROVIDER_LITE;
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_MODEL_LITE;
  delete process.env.AZURE_OPENAI_DEPLOYMENT;
  delete process.env.AZURE_OPENAI_DEPLOYMENT_LITE;
  delete process.env.AZURE_OPENAI_REASONING_EFFORT;
  delete process.env.AZURE_OPENAI_REASONING_EFFORT_LITE;
});

describe("providerFor — role resolves to a provider name", () => {
  it("defaults both roles to gemini when no env is set", () => {
    expect(providerFor("main")).toBe("gemini");
    expect(providerFor("lite")).toBe("gemini");
  });

  it("sets main to azure when LLM_PROVIDER=azure, lite inherits it", () => {
    process.env.LLM_PROVIDER = "azure";
    expect(providerFor("main")).toBe("azure");
    expect(providerFor("lite")).toBe("azure");
  });

  it("sets lite to azure when LLM_PROVIDER_LITE=azure while main stays gemini", () => {
    process.env.LLM_PROVIDER_LITE = "azure";
    expect(providerFor("main")).toBe("gemini");
    expect(providerFor("lite")).toBe("azure");
  });

  it("throws on an invalid provider string", () => {
    process.env.LLM_PROVIDER = "azureEE";
    expect(() => providerFor("main")).toThrow(/azureEE/);
  });
});

describe("cacheModelDimension — role, provider, and model in the key", () => {
  it("under gemini default, key contains 'gemini:'", () => {
    process.env.GEMINI_MODEL = "gemini-2.5-pro";
    expect(cacheModelDimension("main")).toBe("gemini:gemini-2.5-pro");
  });

  it("under gemini lite, key contains 'gemini:' and the lite model fallback", () => {
    process.env.GEMINI_MODEL_LITE = "gemini-3.6-flash";
    expect(cacheModelDimension("lite")).toBe("gemini:gemini-3.6-flash");
  });

  it("under azure, key contains 'azure:' and the deployment name", () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-1";
    expect(cacheModelDimension("main")).toBe("azure:gpt-deploy-1");
  });

  it("under azure, lite deployment inherits from deployment when LITE is not set", () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-1";
    expect(cacheModelDimension("lite")).toBe("azure:gpt-deploy-1");
  });

  it("under azure, lite deployment uses LITE variable when set", () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-main";
    process.env.AZURE_OPENAI_DEPLOYMENT_LITE = "gpt-deploy-lite";
    expect(cacheModelDimension("lite")).toBe("azure:gpt-deploy-lite");
  });

  it("keys differ across providers for the same prompt, proving D-22", () => {
    process.env.GEMINI_MODEL = "gemini-2.5-pro";
    const geminiKey = cacheModelDimension("main");
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-1";
    const azureKey = cacheModelDimension("main");
    expect(geminiKey).not.toBe(azureKey);
  });
});

describe("llmCacheDimension — provider-prefixed cache keys, azure always 'env'", () => {
  it("under azure the fingerprint is 'env' even when an org config exists in this run", () => {
    // The org config is Gemini-only, so an azure run's key/deployment are process-wide no matter
    // which org is paying. Splitting the azure cache per org would be the TD-22 violation in the
    // other direction: identical env credentials serving different answers by tenant.
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-1";
    expect(llmCacheDimension("main")).toBe("azure:env");
    expect(llmCacheDimension("lite")).toBe("azure:env");
  });

  it("identical role under gemini vs azure yields different keys", () => {
    const geminiKey = llmCacheDimension("main");
    process.env.LLM_PROVIDER = "azure";
    const azureKey = llmCacheDimension("main");
    expect(geminiKey.startsWith("gemini:")).toBe(true);
    expect(azureKey).toBe("azure:env");
    expect(geminiKey).not.toBe(azureKey);
  });
});

describe("llm() — delegation to the right provider", () => {
  it("delegates to gemini by default", async () => {
    const res = await llm("hello", { systemInstruction: "sys", role: "main", stage: "ir" });
    expect(res.content).toBe("gemini responded");
    expect(gemini).toHaveBeenCalledTimes(1);
    expect(azureOpenAI).not.toHaveBeenCalled();
  });

  it("never forwards jsonEnvelope to gemini — Gemini's JSON mode returns a bare array as asked", async () => {
    // D-31: the bare-array prompt must stay verbatim under gemini; the wrap-object envelope is
    // an azure-only workaround for json_object mode. Assert byte-identical gemini args.
    await llm("hi", { role: "lite", stage: "testcases", jsonEnvelope: "cases" });
    expect(gemini).toHaveBeenCalledTimes(1);
    expect(azureOpenAI).not.toHaveBeenCalled();
    expect(gemini.mock.calls[0][1]).toEqual({ stage: "testcases", model: "gemini-3.6-flash" });
  });

  it("passes the model string to gemini for the main role", async () => {
    process.env.GEMINI_MODEL = "gemini-2.5-pro";
    await llm("hi", { role: "main", stage: "ir" });
    expect(gemini).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ model: "gemini-2.5-pro", stage: "ir" }),
    );
  });

  it("passes the lite model fallback to gemini for the lite role", async () => {
    process.env.GEMINI_MODEL_LITE = "gemini-3.6-flash";
    await llm("hi", { role: "lite", stage: "plan" });
    expect(gemini).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ model: "gemini-3.6-flash", stage: "plan" }),
    );
  });

  it("delegates to azureOpenAI when the role resolves to azure", async () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-1";
    const res = await llm("do something", { systemInstruction: "sys", role: "main", stage: "ir" });
    expect(res.content).toBe("azure responded");
    expect(azureOpenAI).toHaveBeenCalledTimes(1);
    expect(gemini).not.toHaveBeenCalled();
  });

  it("forwards jsonEnvelope to azureOpenAI but not so much as a leak to gemini", async () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-1";
    await llm("hi", { role: "main", stage: "testcases", jsonEnvelope: "cases" });
    expect(azureOpenAI).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ jsonEnvelope: "cases", deployment: "gpt-deploy-1", stage: "testcases" }),
    );
    expect(gemini).not.toHaveBeenCalled();
  });

  it("passes the deployment name (not a model id) to azureOpenAI", async () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-1";
    await llm("hi", { role: "main", stage: "ir" });
    expect(azureOpenAI).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ deployment: "gpt-deploy-1", stage: "ir" }),
    );
  });

  it("passes lite deployment to azureOpenAI for the lite role", async () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-main";
    process.env.AZURE_OPENAI_DEPLOYMENT_LITE = "gpt-deploy-lite";
    await llm("hi", { role: "lite", stage: "plan" });
    expect(azureOpenAI).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ deployment: "gpt-deploy-lite", stage: "plan" }),
    );
  });

  it("main role defaults reasoningEffort to 'low' — the gpt-5 family is a reasoning model", async () => {
    process.env.LLM_PROVIDER = "azure";
    await llm("hi", { role: "main", stage: "ir" });
    expect(azureOpenAI).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ reasoningEffort: "low" }),
    );
  });

  it("AZURE_OPENAI_REASONING_EFFORT overrides main's effort", async () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_REASONING_EFFORT = "high";
    await llm("hi", { role: "main", stage: "ir" });
    expect(azureOpenAI).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ reasoningEffort: "high" }),
    );
  });

  it("lite omits reasoningEffort when LITE is unset — gpt-4.1-mini rejects the parameter", async () => {
    process.env.LLM_PROVIDER = "azure";
    await llm("hi", { role: "lite", stage: "plan" });
    expect(azureOpenAI.mock.calls[0][1].reasoningEffort).toBeUndefined();
  });

  it("lite never falls back to the main effort var", async () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_REASONING_EFFORT = "high"; // main-only — must NOT leak to lite
    await llm("hi", { role: "lite", stage: "plan" });
    expect(azureOpenAI.mock.calls[0][1].reasoningEffort).toBeUndefined();
  });

  it("lite sends effort only when AZURE_OPENAI_REASONING_EFFORT_LITE is set", async () => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_REASONING_EFFORT_LITE = "medium";
    await llm("hi", { role: "lite", stage: "plan" });
    expect(azureOpenAI).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ reasoningEffort: "medium" }),
    );
  });

  it("role 'main' and 'lite' can use different providers simultaneously", async () => {
    process.env.LLM_PROVIDER_LITE = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-lite";
    await Promise.all([
      llm("main request", { role: "main", stage: "ir" }),
      llm("lite request", { role: "lite", stage: "plan" }),
    ]);
    expect(gemini).toHaveBeenCalledTimes(1);
    expect(azureOpenAI).toHaveBeenCalledTimes(1);
  });
});