# Salesforce runs — the "This URL is a Salesforce org" checkbox and the target-app rail

Behind `SALESFORCE_ENABLED`, default **off**. Decision D-50. Nothing is stored and there are no
database changes.

`tsc --noEmit` clean. Vitest on `main` at `42202f4`: **1692 → 1710 passing** (+18: 16 in
`tests/salesforceOrgRun.test.ts`, and 2 that `tests/booleanEnvFlags.test.ts` generates for each
registered flag). The same 12 real-browser tests fail before and after, at
Chromium launch, in the cloud container only.

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/runTarget.ts` **(new)** | `TARGET_APPS`, `isTargetApp`, `salesforceEnabled`, and the rail: `enterWithTargetApp`, **`currentRunTargetApp()`**, `withTargetApp` — the same three-function shape as the locale rail. |
| `src/orchestrator.ts` | `RunOptions.targetApp?` (optional, additive); the rail entered beside the other three, on every run, with null for an ordinary one. |
| `src/server/index.ts` | `SALESFORCE_ENABLED` in `BOOLEAN_ENV_FLAGS`; POST /api/runs validates and forwards `options.targetApp` and writes `runs/<id>/00-run-target.json`; `GET /api/health` gains `targetApps` only when the flag is on. |
| `public/app.js` | The checkbox, created only when health lists `"salesforce"`; the request body gains `targetApp` only when it is ticked. Reuses `.field-label` and `.lib-check`. |
| `tests/salesforceOrgRun.test.ts` **(new)** | 16 tests. Real runs up to a stubbed planner, so the value is proved to arrive inside the pipeline. |
| `README.md`, `DECISIONS.md` | The flag row; D-50. |

Not touched: anything under `src/stages/`, `src/server/salesforceLogin.ts`, `public/style.css`,
the database.

## 2. FOR THE STAGES THAT WILL READ IT

```ts
import { currentRunTargetApp } from "../runTarget.js";
if (currentRunTargetApp() === "salesforce") { /* Salesforce-specific handling */ }
```

Returns null outside a run, in the CLI and unit tests, with the flag off, and when the box was
not ticked. Never throws.

## 3. FLAG OFF

No checkbox element exists. `/api/health` is byte-identical. POST /api/runs ignores `targetApp`
(never 400s on it) and the rail is entered with null. No `00-run-target.json` is written.

## 4. TO ROLL BACK

Revert the files above. There is nothing in the database to undo; `00-run-target.json` files
left under `runs/` are inert.

## 5. DELIBERATELY NOT DONE

- Nothing reads `currentRunTargetApp()` yet — that handling is being built separately.
- A past run's target app is on disk but not shown in the UI: the run-state route returns a bare
  array and cannot gain a field (rule 1); showing it would need a new route.
- `src/server/salesforceLogin.ts` has no caller; its owner is removing it.
