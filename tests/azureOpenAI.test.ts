import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/llm/backoff.js", async (orig) => {
  const actual = await orig<typeof import("../src/llm/backoff.js")>();
  return {
    ...actual,
    // Straight-through: one attempt, no sleeps. The retry LOOP itself is backoff.ts's tested job.
    callWithPool: async (pool: any, fn: (k: string, s: AbortSignal) => Promise<unknown>, _opts?: any) =>
      fn(pool.next(), new AbortController().signal),
  };
});

import { isRateLimitError } from "../src/llm/backoff.js";
import { azureOpenAI } from "../src/llm/azureOpenAI.js";

/**
 * Request-shape and error-contract tests for the Azure OpenAI provider — no real network, no real
 * retry sleeps.
 *
 * `callWithPool` is swapped for a straight passthrough (the retry *loop* — key rotation, backoff
 * timing, timeout races — is backoff.ts's own concern, already covered in backoff.test.ts). What
 * this file pins is the provider contract that the loop and every caller depends on:
 *   - the request: URL, headers, `body.model` being the DEPLOYMENT name, the message-array shape;
 *   - the json/image additions (json_object mode demands the word "json" be present — appended
 *     instruction; vision rides in as a data-URI image_url content part);
 *   - the error contract: `Azure OpenAI <status>: <body>` with `.status`, `Azure OpenAI
 *     content_filter: <reason>` with `.contentFilter` and NO `.status` — the structural property
 *     backoff.ts checks (`rateLimited(err) === null`) that proves a content_filter refusal is
 *     never retried (a refusal is not a rate limit; retrying it would just re-pay for the same
 *     blocked prompt).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchMock: ReturnType<typeof vi.fn<any>>;

beforeEach(() => {
  process.env.AZURE_OPENAI_ENDPOINT = "https://my-resource.openai.azure.com";
  process.env.AZURE_OPENAI_API_KEY = "azure-key-abc";
  process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-1";
  delete process.env.AZURE_OPENAI_DEPLOYMENT_LITE;

  fetchMock = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: "{\"ok\":true}" } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AZURE_OPENAI_DEPLOYMENT;
});

describe("azureOpenAI — request mapping", () => {
  it("posts to /openai/v1/chat/completions with api-key header and the deployment as model", async () => {
    const res = await azureOpenAI("summarize the page", {
      deployment: "gpt-deploy-1", stage: "plan",
    });

    expect(res.content).toBe("{\"ok\":true}");
    expect(res.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://my-resource.openai.azure.com/openai/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({
      "content-type": "application/json",
      "api-key": "azure-key-abc",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-deploy-1");
    expect(body.messages).toEqual([{ role: "user", content: "summarize the page" }]);
    expect(body.response_format).toBeUndefined();
  });

  it("json:true sets response_format json_object and appends a JSON instruction to the system message", async () => {
    await azureOpenAI("hello", {
      deployment: "gpt-deploy-1", json: true, systemInstruction: "You label things.", stage: "x",
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "You label things.\n\nRespond with valid JSON only.",
    });
  });

  it("keeps the caller's systemInstruction byte-for-byte when json is off", async () => {
    await azureOpenAI("hello", { deployment: "gpt-deploy-1", systemInstruction: "Do a thing.", stage: "x" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "Do a thing." });
  });

  it("sends vision as a data-URI image_url content part, defaulting the mime to image/png", async () => {
    await azureOpenAI("what is in this?", {
      deployment: "gpt-deploy-1", imageBase64: "abc123", stage: "x",
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
        ],
      },
    ]);
  });

  it("never sends temperature — the gpt-5 family rejects it, and ir.ts passes 0.2 on every shared path", async () => {
    // temperature genuinely arrives here: client.ts spreads a shared GeminiOpts (which has the
    // key) straight into azureOpenAI. The cast is the point — this is what a call site's object
    // looks like at runtime, type system notwithstanding.
    await azureOpenAI("describe", {
      deployment: "gpt-deploy-1", imageBase64: "zzz", imageMime: "image/jpeg",
      temperature: 0.3, stage: "x",
    } as any);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[0].content[1].image_url.url).toBe("data:image/jpeg;base64,zzz");
    expect(body.temperature).toBeUndefined();
    expect(Object.keys(body)).not.toContain("temperature");
  });

  it("sends reasoning_effort on the body only when it was resolved (main always, lite only when set)", async () => {
    await azureOpenAI("hi", { deployment: "gpt-deploy-1", reasoningEffort: "low", stage: "x" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).reasoning_effort).toBe("low");

    await azureOpenAI("hi", { deployment: "gpt-deploy-1", stage: "x" }); // lite: LITE var unset
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(body.reasoning_effort).toBeUndefined();
    expect(Object.keys(body)).not.toContain("reasoning_effort");
  });

  it("maps maxOutputTokens to max_completion_tokens, never max_tokens", async () => {
    await azureOpenAI("hi", { deployment: "gpt-deploy-1", maxOutputTokens: 500, stage: "x" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.max_completion_tokens).toBe(500);
    expect(Object.keys(body)).not.toContain("max_tokens");
  });

  it("reads reasoning tokens from completion_tokens_details when the model reports them", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 5, completion_tokens: 7, total_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 18 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await azureOpenAI("hi", { deployment: "gpt-deploy-1", stage: "x" });
    expect(res.usage).toEqual({
      promptTokens: 5, completionTokens: 7, totalTokens: 30, reasoningTokens: 18,
    });
  });

  it("strips a trailing slash from the endpoint", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "https://my-resource.openai.azure.com///";
    await azureOpenAI("hi", { deployment: "gpt-deploy-1", stage: "x" });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://my-resource.openai.azure.com/openai/v1/chat/completions",
    );
  });
});

describe("azureOpenAI — configuration errors", () => {
  it("fails loudly when no deployment is configured, naming both env vars", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT = "";
    await expect(azureOpenAI("hi", { stage: "x" })).rejects.toThrow(/AZURE_OPENAI_DEPLOYMENT/);
  });

  it("fails loudly when the endpoint is unset", async () => {
    process.env.AZURE_OPENAI_ENDPOINT = "";
    await expect(
      azureOpenAI("hi", { deployment: "gpt-deploy-1", stage: "x" }),
    ).rejects.toThrow(/AZURE_OPENAI_ENDPOINT/);
  });
});

describe("azureOpenAI — error contract with the backoff loop", () => {
  it("a generic 400 carries .status and is NOT a rate-limit error (so it never retries)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }));
    const err: any = await azureOpenAI("hi", { deployment: "gpt-deploy-1", stage: "x" }).catch((e) => e);
    expect(err.message).toMatch(/^Azure OpenAI 400: /);
    expect(err.status).toBe(400);
    expect(isRateLimitError(err)).toBe(false);
  });

  it("a 429 carries .status and .retryAfter — the loop's signal to wait and retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Too many requests", {
      status: 429,
      headers: { "retry-after": "2" },
    }));
    const err: any = await azureOpenAI("hi", { deployment: "gpt-deploy-1", stage: "x" }).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe("2");
    expect(isRateLimitError(err)).toBe(true);
  });

  it("a content_filter 400 is a refusal: has .contentFilter, NO .status, and is not rate-limited", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: "content_filter",
        message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy. Please modify your prompt and retry.",
      },
    }), { status: 400 }));
    const err: any = await azureOpenAI("hit the homepage", { deployment: "gpt-deploy-1", stage: "x" }).catch((e) => e);
    expect(err.message).toMatch(/^Azure OpenAI content_filter: .*content management policy/);
    expect(err.contentFilter).toBe(true);
    expect(err.status).toBeUndefined();
    expect(isRateLimitError(err)).toBe(false);
    // The refusal must NOT provoke the retry loop — one attempt only.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("azureOpenAI — truncation and in-band refusal on a 200", () => {
  it("a finish_reason of 'length' throws 'Azure OpenAI truncated: <first 300 chars>' with no .status", async () => {
    const longContent = "x".repeat(1000);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: longContent }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 1000, total_tokens: 1010 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const err: any = await azureOpenAI("hi", { deployment: "gpt-deploy-1", stage: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // First 300 chars only — enough to diagnose, small enough to keep out of a giant log line.
    expect(err.message).toBe(`Azure OpenAI truncated: ${"x".repeat(300)}`);
    expect(err.status).toBeUndefined();
    expect(isRateLimitError(err)).toBe(false);
    // A truncated answer is the same clipped prompt re-billed — never retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a non-empty message.refusal throws 'Azure OpenAI refusal: <message>' with no .status", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "", refusal: "I can't help with that." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const err: any = await azureOpenAI("hi", { deployment: "gpt-deploy-1", stage: "x" }).catch((e) => e);
    expect(err.message).toBe("Azure OpenAI refusal: I can't help with that.");
    expect(err.status).toBeUndefined();
    expect(isRateLimitError(err)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a refusal is checked before finish_reason (a model can refuse with finish_reason 'stop')", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "", refusal: "No." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const err: any = await azureOpenAI("hi", { deployment: "gpt-deploy-1", stage: "x" }).catch((e) => e);
    expect(err.message).toBe("Azure OpenAI refusal: No.");
  });

  it("a clean 200 passes finishReason and refusal through additively", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: "ok", refusal: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await azureOpenAI("hi", { deployment: "gpt-deploy-1", stage: "x" });
    expect(res.content).toBe("ok");
    expect(res.finishReason).toBe("stop");
    expect(res.refusal).toBeNull();
  });
});