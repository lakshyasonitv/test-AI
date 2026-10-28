# Phase report — Discovery upgrade Phase 1: wait until the page really finished loading

**Flag:** `NETWORK_SETTLE_ENABLED` (default off). Decision record: `DECISIONS.md` D-56. Date: 2026-10-19.

## What changed

- **New `src/stages/networkSettle.ts`.**
  - `trackNetwork(page)` keeps ONE tracker per page (`WeakMap`; a second call returns the first tracker, with no
    extra listeners). It counts in-flight fetch/XHR requests and ignores long-lived ones: CometD / streaming /
    long-poll / SSE / socket URLs, a Bayeux `"connectionType":"long-polling"` body, or anything open longer than
    3 s. An aged-out request is dropped from the map and only counted. `close` clears the tracker.
  - `waitForNetworkSettle`: no counted request for 500 ms, capped at 5 s.
  - `settleBeforeSnapshot` = that, then the existing `waitForScreenSettle`. That function moved here unchanged and
    is re-exported from `liveExtend.ts`, so `domDiscovery.ts` can use it without an import cycle. It logs
    `[settle] <where>: network quiet|capped after Nms`.
- **`src/stages/domDiscovery.ts`:** `extractDomModelFromPage` settles first when the flag is on. Every discovery
  snapshot passes through it: single page, each hybrid crawl hop, post-login, live-extend replay. The single-page
  path attaches the tracker before `goto`, and `domCacheKey` gains `settled:`.
- **`src/stages/liveExtend.ts`:** the replay page attaches the tracker at creation. Screen captures and ordinary
  replays use `settleBeforeSnapshot`; with the flag off they take the old `trackInflightRequests` + `quiet` path,
  unchanged. The walk key gains `net-settle:1`.
- **`README.md`:** the flag's row.

### Files owned by others (tell the owners)

- **Yashika, `src/server/index.ts`:** ONE line appended to `BOOLEAN_ENV_FLAGS`: `"NETWORK_SETTLE_ENABLED",`
  (standing approval; nothing else in the file).
- **Garvit, `src/stages/hybridDiscovery.ts`** (diff approved by the owner of the plan before applying):
  - import `{ networkSettleEnabled, trackNetwork }` from `./networkSettle.js`;
  - `strategySuffix` (used by `siteCacheKey` / `hybridKey`) appends `#settled` when the flag is on;
  - `sharedPage` attaches `trackNetwork` when the crawl page is created (flag on), so the entry page's early
    requests are counted.

## How to roll back

Unset `NETWORK_SETTLE_ENABLED` (or set it to `false`) and restart the server. Every code path and cache key is then
exactly as before. To remove the code, revert the files above; `waitForScreenSettle` must go back into
`liveExtend.ts`.

## Tests

- `tests/networkSettle.test.ts`, 7 tests in real Chromium against a local HTTP server:
  - a field loaded by a 1.8 s fetch is MISSED with the flag off and CAPTURED with it on (cheerio and live
    strategies);
  - a never-answered CometD long-poll is ignored by shape (settles in under 2.5 s);
  - a never-answered plain request is set aside by age (3-5 s);
  - attaching twice gives the same tracker, the same listener count and exactly one request in flight;
  - close leaves nothing held;
  - a page that never stops fetching is capped at 5 s.
- Mutations, all caught: no shape detection; no settle in the snapshot (both delayed-field tests fail); no
  one-tracker check.
- Full suite: **2293 passed / 8 failed / 23 skipped, 172 files.** Before this phase it was 2286 / 8 / 23 (171 files,
  with the TD-154/156 fix). The 8 failures are pre-existing. 7 fail identically in a clean worktree at `b12013f`.
  `specRoutes` test 15 passes alone and fails only in the full suite (a cross-file race on `runs/_cache`).

## Live results

Settings for all runs: `DISCOVERY_LIVE_DOM=true`, cold caches, gate off, the same three requests word for word.
OFF = Phase 1 code with the flag unset; ON = flag set. One run per site per setting.

| Metric | SF base | SF OFF | SF ON | Sauce base | Sauce OFF | Sauce ON | Demo base | Demo OFF | Demo ON |
|---|---|---|---|---|---|---|---|---|---|
| Primary | fail | pass* | fail | pass | pass | pass | pass | pass | fail |
| Cases gen / pass / fail | 4/3/1 | 4/3/1 | 4/3/1 | 4/3/1 | 4/4/0 | 4/3/1 | 4/2/2 | 4/2/2 | 4/2/2 |
| Grounding rejections | 1 | 6 | 10 | 1 | 2 | 3 | 1 | 3 | 2 |
| IR calls (retries) | 10 (6) | 20 (16) | 28 (24) | 10 (6) | 14 (10) | 14 (10) | 12 (8) | 20 (16) | 18 (14) |
| LLM calls / tokens | 15 / 85k | 25 / 169k | 32 / 221k | 16 / 76k | 20 / 98k | 20 / 97k | 19 / 122k | 29 / 172k | 25 / 155k |
| Screen captures / reused | 10 / 1 | 21 / 12 | 21 / 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| Screens in primary model | 1 | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| Screen map screens / edges | 2 / 1 | 3 / 2 | 3 / 2 | n/a | n/a | n/a | n/a | n/a | n/a |
| Generated-id locators | 0/41 | 0/48 | 0/48 | 0/45 | 0/44 | 0/44 | 0/37 | 0/45 | 0/42 |
| Settle waits / total / capped | - | - | 35 / 31.7 s / 1 | - | - | 8 / 6.6 s / 0 | - | - | 9 / 11.3 s / 0 |
| Duration (min) | 6.9 | 13.5 | 12.0 | 6.4 | 4.6 | 6.4 | 7.7 | 10.4 | 11.0 |

\* SF OFF "passed" but did not finish the flow. It took the EOI path (Explore Projects → View Project → Select for
EOI → Express Interest → contact screen → Next), then asserted a line of text on form screen 2, not a confirmation.
The form was never submitted.

Run ids:
- baseline: SF `2026-10-18T18-02-44-936Z-8e6de9d7`, Sauce `2026-10-18T17-22-54-631Z-7e5d7867`, Demo `2026-10-18T18-09-38-835Z-4c7f42b4`;
- OFF: SF `2026-10-18T18-38-41-975Z-c62a8e64`, Sauce `2026-10-18T18-52-11-927Z-be162f0e`, Demo `2026-10-18T18-56-52-594Z-2b76eabc`;
- ON: SF `2026-10-18T19-08-24-792Z-25b2c21b`, Sauce `2026-10-18T19-20-24-730Z-f04c7298`, Demo `2026-10-18T19-26-51-088Z-af777456`.

Failure reasons, ON:
- SF case-0: `fill` timeout on `role=textbox[name="Phone Number"s].nth(1)`. The model set `nth: 1`, the screen has
  one such textbox, and grounding lets an out-of-range `nth` through (**TD-157**, pre-existing).
- Sauce case-2: XSS in First Name → `navigation_error` (the same as the baseline).
- Demo case-0: filled the HIDDEN Sign-up `#sign-username` instead of the order form's Name (**TD-158**, pre-existing;
  the visible field's name was "Total: Name:" because the replayed cart was empty, **TD-159**, which also happens with
  the flag off).
- Demo case-1: SQL injection on the Log in modal → timeout (the same as the baseline and OFF).

## What it did and did not show

- **The mechanism works where it can be measured.** On real sites it settled at 540-880 ms on ordinary pages, waited
  2.8-3.2 s on Demoblaze's product pages, and hit the 5 s cap once in 35 Salesforce waits. In real Chromium it
  captures a late-fetched field that the flag-off path misses.
- **No measurable change in the live outcome.** The three runs per site disagree with each other more than OFF and ON
  do. The flag-OFF SF run behaved very differently from the baseline on equivalent code. Both ON failures trace to
  existing grounding defects that the model happened to trigger (TD-157, TD-158), not to the settle.
- **Cost:** +32 s of waiting on the SF run (35 waits), +7 s on Sauce, +11 s on Demoblaze.
- The Experience Cloud test site keeps no CometD long-poll open (at most 1 long-lived request seen), so the
  long-poll exclusion was proven only in the synthetic test, not on a live Salesforce ORG (LS-7).

## Not fixed here

- TD-157, TD-158, TD-159 (filed).
- The settle runs before snapshots only, not between replayed steps (TD-159's race).
- Unexplained: one Demoblaze suite-case replay reported 138 long-lived requests ignored. It still settled ("quiet
  after 1779 ms"), and a local probe of the same pages saw 6 short requests and none held open.
- One run per setting cannot separate a small effect from model variance. A real comparison needs repeated runs or
  a fixed IR replay.
