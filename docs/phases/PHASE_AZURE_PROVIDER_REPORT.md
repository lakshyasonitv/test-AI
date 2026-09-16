# Phase — Azure OpenAI as an optional second LLM provider

A second LLM provider, additive and default-off. Every model call now routes through
`src/llm/client.ts`, which picks a provider per **role** from `LLM_PROVIDER` (`gemini` | `azure`,
default `gemini`). With the selector unset, every stage calls Gemini with exactly the model string
it used before — byte-identical behaviour, verified by the unchanged baseline pass/fail counts.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/llm/client.ts` (new) | `llm()` — the single entry point, provider chosen by `role: "main" \| "lite"`. `providerFor(role)` narrows to `"gemini"\|"azure"` (throws on garbage). `cacheModelDimension(role)` — the model/deployment half of every cache key, now provider-prefixed. |
| `src/llm/azureOpenAI.ts` (new) | The provider mirror of `gemini.ts`: same `{content, usage}` return, same `recordAmbient` spend lines, same `callWithPool` backoff (a one-key `KeyPool`). POSTs to `{AZURE_OPENAI_ENDPOINT}/openai/v1/chat/completions` with an `api-key` header; `body.model` is the **deployment** name. |
| `src/llm/llmContext.ts` | `LlmRole`, `resolvedProvider(role)`, `resolvedDeployment(role)`, and `llmCacheDimension(role)` (the credential-fingerprint dimension, now provider-prefixed). Doc comment notes `orgLlmConfig` is Gemini-only and ignored for an azure role. |
| `src/llm/llmBudget.ts` | `LlmStageUsage` gains a required `provider` field; `record()`/`recordAmbient()` take a required provider. Each line of `08-llm-usage.json` now names who billed it. |
| `src/llm/gemini.ts` | Its two `recordAmbient` calls pass `"gemini"`. No behaviour change. |
| Nine call sites in seven files | `planner`, `discovery`, `hybridDiscovery`, `failureAnalysis`, `ir`, `testCases`, `rewrite` import `llm` instead of `gemini`, and say `role:` not `model:`. Five of those plus `liveExtend`'s walk cache key use `cacheModelDimension(role)`/`llmCacheDimension(role)`. |
| `src/server/index.ts` | Startup guard: `LLM_PROVIDER`/`LLM_PROVIDER_LITE` set to anything but exactly `gemini`/`azure` is fatal (mirrors `findInvalidBooleanFlags`). `/api/health` reports presence/length of the four `AZURE_OPENAI_*` vars and the two selectors (additive). |
| `tests/azureOpenAI.test.ts` (new) | 11 cases — request shape (deployment as model, api-key header, json/image additions), config errors, and the error contract: generic 400 carries `.status`, 429 carries `.status`+`.retryAfter`, content_filter carries no `.status` so `backoff.ts` never retries a refusal. |
| `tests/llmClient.test.ts` (new) | 18 cases — role→provider resolution, lite inheritance/override, cache dimension per provider, `llm()` delegation, mixed providers on main/lite simultaneously. |
| `tests/providerEnvFlags.test.ts` (new) | 28 cases — the boot guard, mirroring `booleanEnvFlags.test.ts`. |
| `tests/llmBudget.test.ts` | Updated for the required `provider` argument/field. |
| `tests/liveExtend.test.ts`, `tests/orgLlmConfig.test.ts` | `llmCacheDimension()` → `llmCacheDimension("main")`. |
| `tests/apiContract.test.ts` | Health env-key list extended additively. |
| docs | `DECISIONS.md` D-29, `TECH_DEBT.md` TD-93, `.env.example`, and this report. |

**Tests: 1276–1277 passing, 0 new failures (baseline 1228 passing).** The two pre-existing
failures (`tests/failureDetail.test.ts`, `tests/tenancy.test.ts`) and the environmental real-
browser suite skips/flakes are unchanged. `npx tsc --noEmit` reports only the three pre-existing
`suiteRunner.ts` errors. The run-to-run ±1 pass drift is the real-browser suites' known
environmental variance, present before this phase.

## 2. NEW FILES

- `src/llm/client.ts`, `src/llm/azureOpenAI.ts`
- `tests/azureOpenAI.test.ts`, `tests/llmClient.test.ts`, `tests/providerEnvFlags.test.ts`

## 3. NEW ENV FLAGS

**`LLM_PROVIDER`** / **`LLM_PROVIDER_LITE`** — default **gemini**. `main` roles (ir, testcases,
rewrite/translate) and `lite` roles (plan, discovery, concept-label, failure-analysis) may be on
different providers: set `LLM_PROVIDER=azure` alone to move both, or add `LLM_PROVIDER_LITE=gemini`
to keep the cheap stages on Gemini. `AZURE_OPENAI_ENDPOINT` / `API_KEY` / `DEPLOYMENT` /
`DEPLOYMENT_LITE` / `REASONING_EFFORT` / `REASONING_EFFORT_LITE` are documented in `.env.example`;
the LITE deployment defaults to the main one, and `REASONING_EFFORT` defaults to `low` on main
while `REASONING_EFFORT_LITE` is only ever sent when explicitly set (gpt-4.1-mini rejects the
parameter).

A present-but-invalid value is a **fatal startup error**, not a silent fallback — the boot guard
runs next to the boolean-flag guard in `isMain`. This is the Azure mirror of the boolean-flags
lesson: `LLM_PROVIDER=azureEE` would otherwise read as gemini forever and bill Google.

## 4. SCHEMA CHANGES

**Prompt/response shapes: none.** `ir.ts`, `testCases.ts` etc. still pass `GeminiOpts`-shaped
options through `llm()`; the provider functions accept the same option set and return
`{content, usage}`. The only data-shape change is inside `llmBudget.ts`'s snapshot
(`provider` added to each stage line of `08-llm-usage.json`) — an additive artifact field, not a
route shape.

## 5. THE SAFETY ARGUMENT

- **No fallback between providers.** A role is bound to one provider; a failure is reported as
  the failing provider's own error. D-21's determinism argument is preserved — see D-29.
- **The cache key now names the provider.** `cacheModelDimension` prefixes every key with
  `gemini:`/`azure:`; the credential-fingerprint dimension does the same. TD-22/D-10 again: the
  non-expiring disk cache would otherwise serve a gemini answer to an azure run forever.
- **`orgLlmConfig` cannot accidentally feed Azure.** Per-org config stays Gemini-only; when a
  role's provider is azure it is ignored at the resolution point. Tested: cache and delegation
  tests assert the resolved deployment/model never comes from the per-org path.
- **An Azure key never reaches disk.** `AZURE_OPENAI_API_KEY` is read straight from env at call
  time into a one-key `KeyPool` and never appears in any prompt, cache key, or artifact (`scrubServedSecrets` already scrubs gemini credential shapes; an azure key is not a shape the
  pipeline ever emits).
- **A content_filter refusal is never retried** — it is the same blocked prompt re-billed, and it
  is structurally excluded from the backoff loop (no `.status`, so `rateLimited()` returns null).
  This mirrors gemini's 400-no-retry contract and is pinned by a test.

## 6. WHAT I DID NOT TOUCH

- **`src/llm/gemini.ts` request/response logic**, `backoff.ts`, `keyPool.ts` — the retry loop is
  shared, unchanged, so azure gets identical rate-limit behaviour with zero new failure
  machinery.
- **Any existing route's request or response shape.** New behaviour (health fields) is additive.
- **`public/`** — nothing; provider choice has no UI (D-29) and `const coverage = "standard"` is
  still load-bearing.
- **`docs/LLM_CONTEXT_BRIEFING.md`** — per its own rule, not edited.
- **`orgLlmConfig`, tenancy, or the editor save/grounding paths** — see TD-93 for what this
  defers, deliberately.

## 7. HOW TO VERIFY

Automated (done, no network): `npx tsc --noEmit` (3 pre-existing errors only), `npx vitest run`.
The `azureOpenAI`/`llmClient` tests mock `fetch` and the two provider modules and never touch a
real endpoint.

**Not yet done, deliberately — costs real Azure money.** Switch-over against a real
`AZURE_OPENAI_ENDPOINT`/key/deployment. Per `CLAUDE.md`, before any live spend:
1. Set `LLM_PROVIDER=azure` (+ deployments) in a local `.env`.
2. `npm run serve`, run a single-case smoke run against any dev site; check
3. `runs/<id>/08-llm-usage.json` shows `"provider": "azure"` per stage and `health` shows the
   variables set.
4. Flip a stage back to `LLM_PROVIDER_LITE=gemini` and confirm mixed providers in the usage file
   and distinct cache keys.

## 8. HOW TO ROLLBACK

Unset `LLM_PROVIDER`/`LLM_PROVIDER_LITE` (or set them to `gemini`) and restart. Every role
resolves to gemini exactly as before; the `azure:`-prefixed cache dimension changes once (a
one-time miss, recorded in D-29), then everything behaves as it did pre-phase. To remove the
code: revert the commit. `llmBudget`'s `provider` field would come with it and
`08-llm-usage.json` reverts to its pre-phase shape.

## 9. DEFERRED / FOUND-NOT-FIXED

1. **Per-org Azure is not a thing** — `orgLlmConfig` cannot hold an Azure key, and per-org model
   for the rewrite routes still only folds in when `GEMINI_MODEL` is unset. Filed as
   `TECH_DEBT.md` TD-93 with the tests that must accompany a fix.
2. **No live Azure verification** was performed (real spend). The verification steps above must
   run against a real deployment before this feature is claimed in a production setting.
3. **`LLM_PROVIDER` is read once per request, not per organisation or per run** — the cold-switch
   scope of D-29. A run-scoped override would need request-shape work (Rule 1) and is deferred.

## 10. PHASE 2 — REQUEST SHAPE, ACCOUNTING, AND THE AZURE CACHE FINGERPRINT

The same providers, same deploy step, and same env flags — this section extends what phase 1
shipped. No new files; three files' interfaces changed (observable only via 08-llm-usage.json,
not via any route shape or external contract).

**What changed and why:**

| File | Delta |
|---|---|
| `src/llm/llmContext.ts` | New `resolvedReasoningEffort(role)`: main always sends (default `"low"` via `AZURE_OPENAI_REASONING_EFFORT`), lite sends only when `AZURE_OPENAI_REASONING_EFFORT_LITE` is set, and never falls back to main (gpt-4.1-mini rejects it). `llmCacheDimension(role)` under azure ALWAYS yields `azure:env` — the lockstep org config is Gemini-only, so splitting azure by tenant would serve different answers on identical env credentials. |
| `src/llm/azureOpenAI.ts` | `temperature` removed from `AzureOpenAIOpts` — never sent, on any path (gpt-5 family rejects it; callers still pass `temperature: 0.2` via a shared `GeminiOpts`, and the body silently ignores it). New `reasoningEffort?: string` → `body.reasoning_effort` only when defined. New `maxOutputTokens?: number` → `body.max_completion_tokens` (never `max_tokens`). `usage.completion_tokens_details.reasoning_tokens` → `reasoningTokens` on `AzureOpenAIUsage` when present, with doc comment explaining when gemini sends nothing and why. Header comment updated to record the model-family rules. |
| `src/llm/client.ts` | Imports `resolvedReasoningEffort` and passes it into the azureOpenAI call. Temperature still appears in `rest` (from `ir.ts:1592`); azureOpenAI ignores it. |
| `src/llm/gemini.ts` | New optional `maxOutputTokens` on `GeminiOpts`, mapped to `generationConfig.maxOutputTokens`. No call site sets it today; it exists so the shared opts shape can carry an output cap to whichever provider runs, each mapping it to its own API's field name. |
| `src/llm/llmBudget.ts` | New `reasoningTokens: number` (default `0`) on `LlmStageUsage`, on the internal byStage map, and on `record()`/`recordAmbient()` usage input — consumed into the per-stage breakdown in `08-llm-usage.json` so reasoning spend is not silently folded into `completionTokens`. `totalTokens` snapshot semantics unchanged (prompt + completion only). |
| docs | D-29 gets a "**Deployments and request shape (phase 2)**" subsection (model rationale, no-temperature rule, `max_completion_tokens`, reasoning-effort semantics, `reasoning_tokens`, azure `env` fingerprint). TD-93 appends a paragraph recording gpt-4.1-mini's Legacy status and the reason `AZURE_OPENAI_REASONING_EFFORT_LITE` must never fall back. `.env.example` gains `REASONING_EFFORT` and `REASONING_EFFORT_LITE` with the semantics documented inline. This report gains this section. |

**Tests (phase 2 delta only, all added to the existing phase-1 files):**

| Test file | Delta cases | What is pinned |
|---|---|---|
| `azureOpenAI.test.ts` | -1 +4 = net +3 (now 14) | Temperature no longer sent (explicit opts + body-key + `Object.keys` absence). `reasoning_effort` present when provided, absent when not. `maxOutputTokens` → `max_completion_tokens`, never `max_tokens`. `reasoning_tokens` read from `completion_tokens_details`. |
| `llmClient.test.ts` | -1 +4 = net +3 (now 21, plus 2 new llmCacheDimension tests) | Main azure sends `reasoningEffort: "low"` by default. Main env override `"high"` reaches azureOpenAI. Lite omits the param when LITE is unset and never falls back to the main var. Lite sends LITE when set. `llmCacheDimension("main")` yields `azure:env` under azure, not `azure:<fingerprint>`. |
| `llmBudget.test.ts` | +1 = now 14 | `reasoningTokens` accumulates per stage in `byStage` and defaults to `0` when absent. Existing `toEqual` expectations updated to include `reasoningTokens: 0`. |
| `liveExtend.test.ts`, `orgLlmConfig.test.ts`, `apiContract.test.ts`, `providerEnvFlags.test.ts` | 0 change in count, assertions unchanged | Still green; `llmCacheDimension` changes only affect the azure path, not gemini. |

**Verification (automated, no network):** `npx tsc --noEmit` (3 pre-existing `suiteRunner.ts` only),
`npx vitest run` — 7 targeted files: 117 passing, 0 new failures.

**Not yet done, deliberately — costs real Azure money.** End-to-end confirmation that `08-llm-usage.json`
shows `reasoningTokens` on a gpt-5 run and that no `temperature` key appears in the live POST body.

**Explicitly NOT done (Rule 3):** `docs/LLM_CONTEXT_BRIEFING.md` was not edited.