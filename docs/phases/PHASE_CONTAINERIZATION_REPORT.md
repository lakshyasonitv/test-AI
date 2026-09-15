# Phase — containerization (D-32)

---

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `Dockerfile` | **New.** `FROM mcr.microsoft.com/playwright:v1.49.0-noble`. Browsers pre-installed, tsx + `@playwright/test` installed at build time as runtime deps, `CMD ["node", "--import", "tsx", "src/server/index.ts"]` — not `npm run serve`. |
| `.dockerignore` | **New.** Excludes `node_modules`, `runs`, `.env*`, `.git`, `docs`, `tests`, `.github`. |
| `docker-compose.yml` | **New.** `build: .`, `shm_size: 1g`, `ports: 3000:3000`, `env_file: .env`, `volumes: ./runs:/app/runs`. |
| `src/browserLaunch.ts` | **New.** `chromiumLaunchOptions()` — reads `CHROMIUM_EXTRA_ARGS` (space-separated), returns `{ args: string[] }`. Byte-identical when unset. |
| `src/stages/domDiscovery.ts` | `chromium.launch()` → `chromium.launch(chromiumLaunchOptions())` |
| `src/stages/hybridDiscovery.ts` | Same at both launch sites (`:279`, `:894`) |
| `src/stages/liveExtend.ts` | Same at `:129` |
| `playwright.config.ts` | `launchOptions: chromiumLaunchOptions()` in `use` — generated spec's runner gets the same flags. |
| `.env.example` | `CHROMIUM_EXTRA_ARGS` documented, empty default, Azure comment. |
| `tests/browserLaunch.test.ts` | **New.** 8 tests — unset/empty/split/re-read + config cross-check (set and unset). |
| `docs/phases/PHASE_CONTAINERIZATION_REPORT.md` | This file. |
| `DECISIONS.md` | D-32 appended. |
| `README.md` | Deployment section rewritten with Azure steps. |

**Verification:**
- `npx tsc --noEmit` — **3 pre-existing errors** in `src/stages/suiteRunner.ts` (lines 348, 382, 420: undeclared `healAttempted`, `deterministicHeal`). These errors are present on `HEAD` before this phase (`git diff HEAD -- src/stages/suiteRunner.ts` is empty). The 3 errors do not involve any file this phase touched.
- `npx vitest run tests/browserLaunch.test.ts` — **8/8 passed**.
- Full `npx vitest run` — **1228 passed, 89 skipped, 2 failed** (see section 10). The 2 failures are real-browser tests that fail identically on the pristine baseline (verified by `git stash` comparison): environmental, not introduced here.

**Base image verification (this host lacks Docker):**
- Tag `v1.49.0-noble` exists in MCR (HTTP 200); no `-jammy` fallback needed.
- `node --version` inside the base image: the base installs `nodejs` from the nodesource
  `node_22.x` repo — Node 22.x, patch depends on the image build date (`created 2024-11-18`,
  likely Node 22.9–22.11). Node 22 ≥ 22.9.0 supports `--env-file-if-exists` but it is not
  used (no `.env` in image; D-32 decision).
- `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` is set in the base image config, browsers pre-installed.

## 2. NEW FILES

- `src/browserLaunch.ts` — single helper, no LLM calls, no schema impact.
- `tests/browserLaunch.test.ts` — 8 tests.
- `Dockerfile`, `.dockerignore`, `docker-compose.yml` — build/packaging only.

## 3. NEW ENV FLAGS

**`CHROMIUM_EXTRA_ARGS`** — string, default empty (unset). Space-separated Chromium command-line
flags forwarded to every browser the server opens. Not a boolean; not added to `BOOLEAN_ENV_FLAGS`
(`booleanEnvFlags.test.ts:124` pins the list and asserts no duplicates — a string var would fail
that guard). Documented in `.env.example` with Azure-specific comment.

## 4. NEW ROUTES

**None.** No existing route shape changed.

## 5. SCHEMA CHANGES

**None.**

## 6. WHAT WAS DELIBERATELY LEFT ALONE

- **`runs/` path resolution.** All `path.join("runs", ...)` and `path.resolve("runs")` calls
  remain cwd-relative. The container uses `WORKDIR /app` plus `volumes: ./runs:/app/runs`.
- **Credential handling.** `TEST_USERNAME` / `TEST_PASSWORD` stay in-process only, never
  written to `runs/` (`scrubServedSecrets`, `redactCredentials`).
- **CSS class names.** No UI changes.
- **Route shapes (platform rule 1).** No request/response modifications.
- **`BOOLEAN_ENV_FLAGS`.** `CHROMIUM_EXTRA_ARGS` is a string, not a boolean — adding it would
  cause `findInvalidBooleanFlags` to reject any non-empty value and would break the pinned
  list assertion in `booleanEnvFlags.test.ts`.

## 7. HOW TO VERIFY

```bash
# Typecheck (3 pre-existing suiteRunner.ts errors — baseline, not introduced here):
npx tsc --noEmit

# The new unit test:
npx vitest run tests/browserLaunch.test.ts
# Expected: 8/8 passed

# Build the image:
docker build -t ai-test-platform .

# Run locally (requires .env with GEMINI_API_KEY[S]):
docker compose up -d
curl http://localhost:3000/api/health
# Expected: 200, { "status": "ok", "env": { "GEMINI_API_KEYS": { "set": true, ... } } }

# Azure Container Apps (see README Deployment section):
# 1. az acr build 2. az containerapp up 3. curl health
```

Note: Docker is not available in the verification host for this session; build/compose
steps are provided but not executed.

## 8. HOW TO ROLL BACK

- Remove `Dockerfile`, `.dockerignore`, `docker-compose.yml`.
- Delete `src/browserLaunch.ts` and `tests/browserLaunch.test.ts`.
- Revert edits to `domDiscovery.ts`, `hybridDiscovery.ts`, `liveExtend.ts`,
  `playwright.config.ts`, `.env.example`, `DECISIONS.md`, `README.md`.
- No data or schema to unwind; no route was changed.

## 9. WHAT WAS FOUND BUT NOT FIXED

1. **`suiteRunner.ts:348,382,420` — undeclared variables `healAttempted` and
   `deterministicHeal`.** Pre-existing on `HEAD`, unrelated to this phase. These
   variables are used as accumulators but never declared in the `for`-loop's scope.
   Blocked `npx tsc --noEmit` before this phase began.
2. **Real-browser tests fail in this environment.** Tests that launch Chromium
   (`genericClickables`, `walkCredentials`, `selectAction`, `selectResolution`,
   `authCrawl`, `dialogFieldResolution`) fail on both the pristine baseline and the
   modified code. The test host cannot run Chromium — verified by `git stash`
   comparison. This is an environment limitation, not a regression.
3. **No readiness probe.** `/api/health` (`server/index.ts:554`) always returns 200
   with variable-presence metadata; it never returns non-200 regardless of Gemini key
   presence, DB status, or browser availability. A meaningful readiness check (Gemini
   key present + DB reachable + browsers installed) is a separate concern.
4. **Non-root user.** The Playwright base image bakes in `pwuser`. ACA Azure Files
   volume permissions require uid-based mount options; adding a non-root USER to the
   Dockerfile is deferred until that is decided.

## Image build moved to GitHub Actions

The image is no longer built by Azure. ACR Tasks is blocked on this student subscription —
Azure for Students rejects the operation with `TasksOperationsNotAllowed` — so the container
is now built in CI (`.github/workflows/image.yml`, separate from `test.yml`) and pushed to
GHCR: `ghcr.io/<owner>/testbench:v1` and `ghcr.io/<owner>/testbench:<sha>` on every push to
`main` (and on `workflow_dispatch`). Azure Container Apps pulls `testbench:v1` from GHCR
instead of `az containerapp up --source`. `cache-from`/`cache-to: type=gha` reuse the ~2GB
Playwright base layer on rebuilds.

Container Apps environment details:
- **Deploy region is `koreacentral`** — the student subscription's region policy allows only
  that single region, so no other is used.
- The environment was created with **`--logs-destination none`**, so no Log Analytics
  workspace is attached and container logs sink nowhere on purpose.

Deliberately not fixed here: no change to the `Dockerfile`, `.dockerignore`, `src/`,
`playwright.config.ts`, or any route; `docs/LLM_CONTEXT_BRIEFING.md` not edited.