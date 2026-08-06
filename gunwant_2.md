# gunwant_2 — Prompt Shortening Without Slicing

Goal: shorten LLM prompts (IR generation, concept labeling, failure analysis) WITHOUT cutting text
so essential details survive. Previously a hard `slice(0, N)` truncated prompts mid-content,
dropping instructions, the user's `sourcePrompt`, and even the "Return IR JSON" contract.

## Changes

### 1. `src/schema/appModel.ts` (new: lines 231-340)
- **`serializeModel()` (L231)** — compact line format replaces `JSON.stringify` of the app model.
  Same info, ~50% smaller (no JSON brackets/quotes/key names). Nothing is cut; the format is just leaner.
- **`elementRelevance()` (L267)** — scores each element against the test feature; lower score = safe to drop first.
- **`serializeModelWithinBudget()` (L291)** — the ONLY size control. If the model is over budget it prunes
  **whole pages** (tail first, entry page always survives), then **whole elements** (least-relevant first),
  and re-serializes the survivors whole. Never splits a line or element.

### 2. `src/stages/ir.ts` (removed slice, added pruning: lines 6, 737-748, 764-768, 774-786)
- **L6** — import `serializeModelWithinBudget` instead of `toLiteModel`.
- **L737-748** — serialize the app model within `IR_MAX_MODEL_CHARS` (default 28K) via relevance pruning; log what was pruned.
- **L764-768** — prompt now embeds the compact model text; `Test case`, `sourcePrompt`, and the
  `Return IR JSON` contract are fixed and never touched.
- **L779-786** — last-resort guard: if the fixed parts alone exceed `IR_MAX_PROMPT_CHARS` (default 60K),
  throw a clear error instead of sending a broken prompt.
- **REMOVED** — old `prompt.slice(0, 30_000)` hard cap that cut off the prompt tail.

### 3. `src/text.ts` (new file)
- **`cutAtBoundary()`** — cuts at the last line/paragraph break before the limit, so a sentence or
  heading always survives intact; appends a "chars omitted" note.

### 4. `src/stages/hybridDiscovery.ts`
- **L26, L52** — concept-labeling markdown trimmed with `cutAtBoundary` (was `markdown.slice(0, 4000)`).

### 5. `src/stages/liveExtend.ts`
- **L15, L61** — captured page text capped with `cutAtBoundary` (was `.slice(0, 8000)`).

### 6. `src/stages/failureAnalysis.ts`
- **L10, L59** — error text capped with `cutAtBoundary` (was `.slice(0, 8000)`).

## Reasoning (simple)
- **Why not slice?** Slicing cuts wherever the byte limit lands — mid-JSON, mid-sentence — and the
  prompt tail (instructions, user request) is exactly what gets lost. The model then returns garbage.
- **Compact serialization** shrinks the prompt for free without dropping any detail.
- **Prune, don't cut** — the only size control drops whole units (page → element) by feature relevance,
  so everything still present is fully intact and usable.
- **Fail loudly** — if it genuinely can't fit, an explicit error beats silently corrupting the prompt.

## Verification
- `npm run typecheck` — clean
- `npm test` (scoped `tests src`) — 211/211 pass
