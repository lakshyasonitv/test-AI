# Phase 2 — the Salesforce screen map ("Application Universe", minimal)

Handoff `docs/handoff/HANDOFF_SCREEN_MAP_AND_LOCATORS.md`, Phase 2 (2a record, 2b use). Rationale:
`DECISIONS.md` **D-54**. The handoff's own text says D-53, which Pro intake had already taken.

> **STATUS (2026-10-15):**
> - **Flag registered** with the owner's approval: one line appended to `BOOLEAN_ENV_FLAGS`, and
>   `.env.example` documented.
> - **Real site** (local, flag on), Experience Cloud sandbox:
>   - `2026-10-15T17-50-49-855Z-04a8bda1` (detailed prompt, cold map) **passed the whole flow**:
>     24 steps, "Thank You" and "Your interest has been registered" asserted, **6 IR calls** against the
>     Phase 1 baseline of 8. The map recorded 5 screens and 6 edges.
>   - `2026-10-15T18-02-40-894Z-e269fbfa` (a much SHORTER prompt, warm map) **reached the Thank You
>     page** (10 IR calls). It asserted only a URL, because of TD-132, which was fixed after it.
> - **Still owed:** the same request re-run on a warm map, for the handoff's "second run cheaper than
>   the first" number. The `[ir] screen map predicts` lines are in the server log, not the artifacts.

**Tests:** `tsc` clean. The registration test passes; the remaining failures are the `5196487` baseline's.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/screenMap.ts` | **New.** Types per the handoff (`ScreenMap`, `ScreenMapScreen`, `ScreenMapEdge`) and the module's functions. Constants: caps of 60 screens / 200 edges, least recently seen dropped first, and a TTL on read. |
| `src/stages/ir.ts` | All gated on `SCREEN_MAP_ENABLED` **and** a Salesforce run. See the breakdown below the table. |
| `tests/screenMap.test.ts` | **New.** Covers merge/replace, add, edge dedupe and re-keying, both caps, TTL, the per-site/org/login keys, and redaction of the stored map and the run artifact. |
| `tests/screenMapRuns.test.ts` | **New.** Real Chromium, two runs on a two-screen form. Run 2's **first** prompt names screen 2 with "opened by clicking button "Next"", it needs fewer IR calls than run 1, and `09-screen-map.json` is written. With the flag off: no block and no artifact. Also the owner's isolation line: `screenMode` comes from `options.targetApp` alone, so Pro's `options.spec` cannot change it. |
| `DECISIONS.md` D-54 | Why a disk cache and not the DB; why hints and not evidence; names only; the "opened by" addition. |

**Functions in `screenMap.ts`:** `screenMapEnabled`, `screenMapTtlMs`, `screenMapKey`, `screenFromPage`,
`mergeIntoMap`, `withinTtl`, `loadScreenMap`, `recordIntoScreenMap` and `writeRunScreenMap`.
- **Key:** site host + `"salesforce"` + `llmCacheDimension("main")` + `credentialFingerprint` +
  `llmCacheVersion()`.
- **TTL:** `SCREEN_MAP_TTL_MS`, default 7 days, enforced on read.

**The changes in `src/stages/ir.ts`:**
- **2b, read side:**
  - The stored map is loaded before the IR cache key. Its signature (screen keys + controls + edges)
    joins the key only when the map is non-empty.
  - `capturedScreensBlock` gains the stored screens as a second source. They go first, so the 8-screen
    cap drops them before this run's own captures, and a screen captured again in this compile is
    shown once.
  - Each stored line is marked "(from an earlier run — may have changed)" and names the click that
    opens it.
  - With stored screens the block is sent on the **first** attempt too, under its own header.
  - `[ir] screen map predicts: …` is logged for each screen-changing click the map knows.
- **2a, write side:**
  - After each successful `captureScreenAt`, the screen (`controlsOf`, the same projection the block
    uses) and the edge from the previous screen are recorded. The edge is the last click/press in the
    replayed prefix, role + name only.
  - The stored map is saved and `runs/<id>/09-screen-map.json` is rewritten. Both go through
    `redactCredentials`, and the artifact is written from `screenMap.ts`, **not** `orchestrator.ts`.

## 2. NEW ENV FLAGS / ROUTES / SCHEMA

- `SCREEN_MAP_ENABLED`, a boolean, default off. Registered in `BOOLEAN_ENV_FLAGS` and documented in
  `.env.example`.
- `SCREEN_MAP_TTL_MS`, a number, default 604800000 (7 days).
- New artifact `runs/<id>/09-screen-map.json` (additive).
- No route, no schema change, no migration.

## 3. HOW IT WAS VERIFIED

**Flag off.** Behaviour is unchanged: the ordinary retry-prompt fixture, the Salesforce null-run pins,
the Phase 1b cap tests and the multi-screen wizard all pass. The flag-off test shows no block and no
artifact even when a map exists.

**Mutation checks:**

| Mutation | Caught by |
|---|---|
| Merge always appends (the handoff's) | `screenMap` "replaces … bumps seen", "edges … follow a replaced key" |
| Key without the org dimension (the handoff's) | `screenMap` "another organisation … sees nothing" |
| No redaction on save | `screenMap` "a control name carrying the password …" |
| TTL not enforced | `screenMap` "an expired screen is dropped on read" |
| Stored screens not shown on the first attempt | `screenMapRuns` "run 2's FIRST prompt …" |
| Flag ignored | `screenMapRuns` "flag off …" |
| No edge recorded | `screenMapRuns` "run 2's FIRST prompt …" (the "opened by" hint) |

The handoff expected the org-dimension mutation to fail the **tenancy** test. That cannot happen with
this provider: with `LLM_PROVIDER=azure`, `llmCacheDimension("main")` is `"azure:env"` for every
organisation. Tenants are told apart by the dimension only when per-org LLM keys are configured
(`ORG_LLM_CONFIG_ENABLED`). The new test mocks the dimension to prove the key carries it.

## 4. HOW TO ROLL BACK

- Turn it off: set `SCREEN_MAP_ENABLED=false` or leave it unset.
- Forget the maps: delete the cache's `screenmap` namespace (`llmCacheClear("screenmap")`).
- Remove the code: revert the commit.

## 5. DELIBERATELY NOT DONE

- **Captures are not skipped on a predicted screen.** That is a later optimisation, once the map has
  proven accurate.
- **No route.** A `GET /api/projects/:id/screen-map` can come later.
- **The test-case generator does not see the map yet.** That is Gap 1 in the task list, and the reason
  a minimal prompt still cannot finish a multi-screen flow.
- **Dropdown options are not stored** (Gap 2).
- **On Azure, tenant separation comes from the site and the login, not the org dimension.** See the
  note in section 3.
