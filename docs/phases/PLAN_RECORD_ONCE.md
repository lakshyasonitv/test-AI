# Plan — Discovery upgrade Phase 6: "record once" (NOT STARTED, plan only)

**Status:** a plan for approval. No code exists. It needs new routes in `src/server/index.ts` and UI in
`public/app.js`, which need their owners' agreement (the plan said: write this, then stop).

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
