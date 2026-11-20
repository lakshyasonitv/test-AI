# Plan — Discovery upgrade Phase 6: "record once" (v1 BUILT on branch `feat/recorder`, behind `RECORDER_ENABLED`)

**Status:** decided 2026-11-20: option C (a live browser inside the app). Steps 1–3 of "Option C in
detail" are built: `src/stages/recorder.ts` (pure), `src/server/recorderSessions.ts` (browser),
7 routes in `src/server/index.ts`, `web/src/pages/record/` (UI), tests `tests/recorder.test.ts` and
`tests/recorderSession.test.ts` (a real Chromium). Verified end to end on the LMS site: record →
save → replay passed. Research behind the choices: `reports/Recorder research.md`.

**One change from the design below:** clicks are NOT captured by an injected page script. Every input
already passes through the server, so the server names the element under the click (Chromium's
accessibility tree for role + exact name, then the generated spec's own Playwright locator checked for
uniqueness) *before* it clicks. Nothing is injected into the site; CSP does not apply.

The comparison below is kept as the record of what was weighed.

## The idea

A person walks the flow ONCE on the real site, and the system turns that walk into what Phases 1–5 can only guess
at: the real screens, the real clicks between them (screen-map edges), and a first test case whose every step
names a control the person actually used. It fills the gap the explorer cannot (Phase 5 never clicks "Select for
EOI", "Express Interest" or "Submit", by design).

## The one decision that shapes everything: where the recording happens

The product runs headless in an Azure Container App, so the server cannot open a browser window for the person.

| Option | How | Cost | Risk |
|---|---|---|---|
| **A. Bookmarklet / injected recorder (recommended)** | The person opens the target site in their own browser and runs a small recorder script. It captures each click/type as role + accessible name + screen fingerprint and posts it to our server. | Small: one script, three routes, one panel | Cross-origin POST (CORS + a one-time recording token); CSP on some sites blocks injected scripts (Salesforce Lightning does) |
| B. Browser extension | The same recorder, packaged as an extension: no CSP problem | Medium: an extension to build, sign and distribute | Distribution and updates |
| C. Server-side headless browser streamed to the UI | A live screencast in the app, clicks forwarded | Large | Latency and complexity; a remote browser holding the person's session |
| D. Local `playwright codegen`, script uploaded | The person runs codegen locally; we parse the script | Small server side | Needs Node on the person's machine; codegen's selectors are css-first, not role-first |

**Recommendation:** start with **B** for Salesforce (Lightning's CSP blocks bookmarklets), keeping A for ordinary
sites. Decide before any code.

## What it would need

1. **Flag:** `RECORDER_ENABLED` (default off), appended to `BOOLEAN_ENV_FLAGS`.
2. **Routes (new, rule 1: no existing route changes):**
   - `POST /api/recordings`: start a session and return a short-lived token (project-scoped, `tester` role).
   - `POST /api/recordings/:id/events`: an append-only list of
     `{ action, role, name, screen: {url, title, labels}, valueKind }`.
   - `POST /api/recordings/:id/finish`: convert, and return a proposed case (step text).
3. **`src/stages/recorder.ts` (new, pure):**
   - events → screen-map screens + edges (names only, the same shape and key as `recordIntoScreenMap`);
   - events → step TEXT in the step editor's English format, so the result goes through the ordinary
     parse → ground → diff → approve path (D-27: nothing writes to the library directly).
4. **Credentials:** a recorder must never send a password value. Password-type fields send `valueKind: "secret"`
   and become `${env:TEST_PASSWORD}`. Other values are sent only when the person ticks "keep typed values"; the
   default is a placeholder.
5. **UI (`public/app.js`):** a "Record a flow" entry on a project, a panel showing the live event list, and "Finish".
   It reuses existing classes (rule 3), and switches views only through `showView()` (rule 4).
6. **Tenancy:** recordings belong to an org/project like test cases. With `DB_ENABLED`, a table with RLS (a
   migration, so the owner applies it, not this stream).
7. **Tests:**
   - recorder → screen map and step text (pure);
   - a real-Chromium test injecting the recorder into a synthetic two-screen form and posting to a test server;
   - a route test proving the token is project-scoped and a password value never reaches disk (`runs/`, the
     LLM cache, logs).

## What it would NOT do

- It would not replay the recording as the test. The recorded steps are re-grounded like any edited case, so a
  stale recording fails at grounding, not at run time.
- It would not record on sites where the injected script is blocked (option A). Option B removes that.

## Effort (rough)

Option A: 2–3 days including tests. Option B: +2 days for the extension. Either needs the owners of `index.ts` /
`app.js` and an agreed decision on the table above first.

---

## Option C in detail (chosen 2026-11-20)

The person opens a site **inside Testbench**: a real Chromium runs on the server, its screen streams into the
page, and the person's clicks and keys are sent back to it. Every action is recorded as *what was touched*
(role, accessible name, label, test id, URL), not as pixels, and becomes step text the person reviews and
saves. Why C over A/B: nothing to install, and it works on sites whose CSP blocks injected scripts
(Salesforce Lightning), because Playwright injects through the DevTools protocol, which CSP does not govern.
Reflect works this way; mabl retired its browser extension for a separate app.

### How it works

```
React page #/record            server (Express)                    Chromium (headless, on the server)
──────────────────            ─────────────────                   ──────────────────────────────────
<img> = latest frame  ◄─poll── GET  /frame  ◄── screencast frames ── CDP Page.startScreencast (JPEG)
click / keys / scroll ──POST─► POST /input  ──► page.mouse / page.keyboard ──► the site
step list (live)      ◄─poll── GET  /events ◄── __tbRecord(...) ◄── init script on every page
"Save as test case"   ──POST─► POST /save   ──► parseIrSteps → IR → new case (v1)
```

1. **Live view.** `Page.startScreencast` (JPEG, quality ~60, max 1280×800) over a CDP session. The server keeps
   only the LATEST frame in memory; the page polls `GET /frame` every ~150 ms. Polling, not a WebSocket: the UI
   already polls everywhere (`CLAUDE.md`: the UI never streams), Express needs no new dependency, and Azure
   ingress needs no change. A WebSocket is a later upgrade if typing feels slow.
2. **Input.** The page sends batched input — `{click x,y}`, `{key "Enter"}`, `{text "abc"}`, `{scroll dy}` —
   scaled to the browser's viewport; the server replays it with `page.mouse` / `page.keyboard` (Playwright),
   so every event goes through a real CDP session (Chrome drops raw `Input.dispatch*` sent without one).
3. **Capture.** `context.exposeBinding("__tbRecord")` plus `context.addInitScript(...)`: a listener in the
   capture phase on `click`, `change`, `input` (debounced) and `submit` reports, for the element touched:
   role (explicit or implicit), accessible name (aria-label / aria-labelledby / `<label>` / text), label,
   placeholder, `data-testid`, `id`, `name`, input type, the page URL and title, and the frame path. The init
   script is a **string with everything inlined** — no named inner functions (`TECH_DEBT.md` TD-40: tsx's
   `__name` helper does not exist in the browser). Navigations are recorded from `page.on("framenavigated")`.
4. **Events → steps (`src/stages/recorder.ts`, pure, no LLM — D-06).**
   - first URL → `navigate`; a click → `click` on `{role, name}` (fallbacks: label → placeholder → testId → text);
   - consecutive typing into one field → one `fill`; a password field → `fill` with `${env:TEST_PASSWORD}`
     and the email/username field before it → `${env:TEST_USERNAME}` (rule 5);
   - `<select>` → `select`; checkbox/radio → `check`; Enter → `press`;
   - **Check mode:** a toggle in the panel; while it is on, the next click adds `assert visible` on that element
     instead of clicking it (Playwright codegen's assert mode). A page change can add `url_contains`.
   - Output is step text via `formatIrStep`, shown live in the side panel, editable before saving.
5. **Save.** `POST /api/recordings/:id/save {projectId, title, suiteId?, stepsText}` re-parses the text with
   `parseIrSteps` (the real parser, as the editor does), builds the IR (`meta.sourcePrompt = "Recorded flow"`),
   and inserts a new case through the same insert `saveCaseFromRun` uses (a new `saveCaseFromIr` beside it).
   A recorder is not a model, so this is a person saving their own steps — but it still goes through the parser
   and an explicit Save, never a silent write (rule 6 / D-27). The person then runs it with the existing replay.

### Routes (all new, behind `RECORDER_ENABLED`, default off; no existing route changes — rule 1)

| Route | Role | Does |
|---|---|---|
| `POST /api/recordings` `{projectId, url}` | tester | start a session: launch Chromium, open the URL; returns `{recordingId}` |
| `GET /api/recordings/:id/frame` | owner of the session | the latest JPEG (`Cache-Control: no-store`) |
| `POST /api/recordings/:id/input` | owner | an array of input events |
| `GET /api/recordings/:id/events?since=N` | owner | captured actions + current step text |
| `POST /api/recordings/:id/check-mode` `{on}` | owner | toggle Check mode |
| `POST /api/recordings/:id/save` | owner (tester) | save as a new case (above) |
| `DELETE /api/recordings/:id` | owner | close the browser |

`GET /api/health` gains an optional `recorder: true` field (optional fields only — rule 1).

### Safety

- **Passwords:** the person types into the remote page, so keystrokes pass through server memory to Chromium.
  They are never logged, never put into an event, never written to `runs/`, the DB or the LLM cache. A password
  field's event carries `valueKind: "secret"` only. A test proves no typed value reaches disk.
- **Who can drive:** the session belongs to the user and org that started it (random 128-bit id); every route
  checks both. `AUTH_ENABLED=false` uses the synthetic local owner, so the checks still run (rule 7).
- **SSRF:** the server's Chromium must not reach the server's own network. Block private and link-local ranges
  (10/8, 172.16/12, 192.168/16, 127/8 except in local dev, 169.254.169.254 metadata) with `context.route` on
  every request, and re-check after redirects.
- **Resources:** one Chromium per session (~300 MB). `RECORDER_MAX_SESSIONS` (default 2), a 10-minute idle
  timeout, and a 30-minute hard cap; the browser closes on save, cancel, timeout or server shutdown.

### UI (React app only, at first)

`#/record?projectId=…`: the live screen on the left (an `<img>` the person clicks and types into), the step list
on the right (edit, delete, reorder), with Check mode, Undo last step, Cancel and Save as test case. A "Record a
flow" button on the Project page, shown only when `/api/health` reports `recorder: true`. The classic UI is not
changed; it can link to the React page later. New classes are `rx-*` only (rule 3 protects `style.css`).

### What is known to be hard (do later, one at a time)

New tabs and popups (Ctrl+click, `target=_blank`), cross-origin iframes, file upload (needs a file picker that
uploads to the server first), drag and drop, hover-only menus (record as `preAction: hover`), canvas apps, and
sites that detect headless Chromium. mabl still ships fixes in this area in 2026; expect a long tail.

### Build order and effort (rough)

| Step | What | Days |
|---|---|---|
| 1 | Session lifecycle, screencast, input forwarding, SSRF guard, limits. Demo: drive a site from inside the app | 3 |
| 2 | Capture script, events → steps, live step list, password handling, Check mode | 2–3 |
| 3 | Save as case, then replay it; tests: pure converter, a real-Chromium test on a synthetic two-screen form, route + tenancy rows, "no typed value on disk" | 2–3 |
| 4 | Polish: undo, step editing, timeouts, docs (`ARCHITECTURE.md`, `README.md`, `.env.example`, a phase report) | 1 |

About **8–10 working days** for a version a client can use on ordinary sites. The hard cases above come after.

### Open questions for the owners

1. React-only UI for this feature is fine? (The classic UI would get a link, not a port.)
2. Is 2 concurrent sessions enough for the Azure container's memory, or should recording run on a separate worker?
3. Should a saved recording also store the raw event list (no values) for debugging, or only the case?
