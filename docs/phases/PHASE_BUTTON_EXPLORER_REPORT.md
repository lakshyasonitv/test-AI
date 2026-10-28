# Phase report — Discovery upgrade Phase 5: the safe button explorer

**Flags:** `BUTTON_EXPLORER_ENABLED` (default off), `EXPLORER_MAX_CLICKS` (default 15), `EXPLORER_BUDGET_MS` (default
120000). Decision record: `DECISIONS.md` D-60. Date: 2026-10-19.

## What changed

- **New `src/stages/buttonExplorer.ts`:** the policy (`classifyControl`, pure), the explorer (`exploreButtons`) and
  `runs/<id>/explorer.json`.
  - **Deny always wins:** destructive or committing names (delete, remove, submit, save, send, pay, purchase, buy,
    checkout, confirm, approve, reject, log out, publish, place order, add to cart, register, sign up, reset,
    clear, cancel, download…), a submit button inside a form, an off-site link.
  - **Allow, structure first:** `role=tab`, `aria-haspopup`, `aria-expanded`; then navigational names (New, Next,
    Back, Previous, View, Open, Show, More, Details, Explore, Expand, See, Browse).
  - **Network guard:** every non-GET navigation is aborted while exploring. Never types.
  - **After each click:** settle (Phase 1's wait), snapshot, record, restore (Escape → dialog Close → Back →
    reload), and verify the original screen is back; abandon a page it cannot restore. Click-once per control,
    at most 4 pages, depth 1.
  - **Results:** new same-origin pages join the app model (at most 3). On a Salesforce run with
    `SCREEN_MAP_ENABLED`, screens and the opening clicks go into the stored screen map (names only, hints, D-54).
- **`src/orchestrator.ts`:** called inside the discovery step, so `02-appmodel.json` holds its pages. It never
  throws.
- **`src/stages/ir.ts`:** `SCREEN_CONTROL_ROLES` exported (so explorer screens list the same controls as captures).
- **Files owned by others:**
  - Yashika, `src/server/index.ts`: one line appended to `BOOLEAN_ENV_FLAGS`, `"BUTTON_EXPLORER_ENABLED",`.
  - Garvit, `src/stages/ir.ts`: the `export` keyword on `SCREEN_CONTROL_ROLES`, plus the TD-158 reveal-check change
    (the Phase 1 follow-up).
  - `src/orchestrator.ts`: the discovery-step wiring.

## How to roll back

Unset `BUTTON_EXPLORER_ENABLED`; the discovery step is then exactly as before. Remove the module and the 6-line
wiring to delete it.

## Tests

- `tests/buttonExplorer.test.ts`, 6 tests, real Chromium on a local server that COUNTS destructive requests:
  - the policy table;
  - it finds the tab's screen, the "New" dialog and a new page; it never deletes and never submits (proven by the
    server's counters); every click that changed something was restored;
  - Salesforce + screen map: the screens and the clicks that open them are stored, names only;
  - the network guard ALONE stops a form post fired from an allowed control's script;
  - `EXPLORER_MAX_CLICKS`.
- Mutations: no deny list → the server records the delete; no submit-in-form check → the test fails (and "Go" is
  still skipped by the allow list: defense in depth); no network guard → the server received 2 posts.
- Final full suite: **2329 passed / 7 failed / 23 skipped, 177 files.** These are the pre-existing failures;
  `specRoutes` test 15, the cross-file race, did not trigger this time.

## Live results (all flags on; COLD caches again, like Phases 1-3)

| Metric | SF P4 (warm) | **SF P5** | Sauce P4 | **Sauce P5** | Demo P4 | **Demo P5** |
|---|---|---|---|---|---|---|
| Primary | pass* | **pass*** | pass | **pass** | pass | **pass** |
| Flow | Explore → View Project → … → Next | **View Project → Select for EOI → Express Interest → Next** | full checkout | full checkout | → Purchase | → Purchase |
| Cases gen / pass / fail | 4/4/0 | **4/4/0** | 4/2/2 | 4/3/0 +1 truncated | 4/3/1 | 4/3/1 |
| Grounding rejections | 2 | **0** | 1 | 1 | 2 | 1 |
| IR calls | 14 | **10** | 16 | 12 | 18 | **10** |
| LLM calls / tokens | 18 / 127k | **14 / 99k** | 22 / 106k | 18 / 87k | 22 / 147k | 17 / 113k |
| Captures (replaced / added) | 19 (16/3) | 16 (13/3) | 0 | 0 | 0 | 0 |
| Locators on numbered ids | 12/42 | 6/37 | 0/48 | 0/43 | 0/42 | 0/36 |
| Explorer clicks / new pages / time | – | 4 / 1 / 21.5 s | – | 10 / 1 / 29.9 s | – | 4 / 0 / 17.3 s |
| Duration (min) | 6.9 | 6.4 | 6.1 | 5.3 | 6.4 | 8.2 |

\* The SF primary still ends by asserting a line of form text after Next, not a submitted confirmation.

Explorer, per site (`runs/<id>/explorer.json`):
- **SF:** clicked Explore Projects, View All Projects (both no change), **View Project → new page** (project details,
  restored with Back), Next. Denied: Download Brochure, the phone and email links (off-site).
- **Sauce:** clicked Open Menu and product "View details" links (5 new pages, 1 kept within the cap). Denied: Add to
  cart, Checkout, the Login submit button (submit in a form), the social links.
- **Demo:** clicked only the carousel's Previous/Next. Denied: Sign up, Place Order, Add to cart.

Run ids (Phase 5): SF `2026-10-19T09-29-10-799Z-b9c5e974`, Sauce `2026-10-19T09-35-37-847Z-eb223ab4`, Demo
`2026-10-19T09-40-57-742Z-f3bd60b6`. Password: 0 hits in the runs, the explorer files and the logs.

Failure reasons: Sauce case-3 truncated (an invalid-card case on a site with no card field); Demo case-1 SQL
injection on the Log in modal → timeout (as every run).

## Verdict

- **What went right:**
  - All three primaries passed from a cold start. (Phase 1's flag-OFF round did that too, with the same kind of
    hollow SF pass, so pass/fail alone is no better than P1-OFF. What improved is HOW the SF primary got there.)
  - On SF, the explorer put the project page into discovery, so the primary went straight to "View Project",
    with 0 grounding rejections and the fewest LLM calls of any run.
  - Every click was safe: nothing destructive clicked, nothing posted, everything restored.
- **What went wrong / surprises:**
  - The explorer never reaches the EOI form: "Select for EOI" / "Express Interest" are, correctly, not on the
    allow list. The SF primary still never submits the form.
  - On Demoblaze, the only allowed controls were the carousel, so it learned nothing there.
- **How much it improved:** pass/fail is no better than Phase 1 flag-OFF (which also passed all three). On SF the run is far
  cheaper than P1-OFF (0 rejections vs 6, 10 IR calls vs 20, 99k tokens vs 169k). Against the baseline (15 / 85k, failed
  primary on a wrong path) the cost is about the same. One run per site, so read it as "consistent with an
  improvement", not as proof.
- **Risk before a real Lightning org:** "Next" is allowed, and the guard blocks only non-GET navigations. Aura writes
  through POST XHR, so a Screen Flow that commits records between screens is protected only by the name lists. Tested
  on Experience Cloud only (LS-7).
- **Not fixed:** the hollow SF pass (no check that the final assert sits on a finished screen), TD-157, TD-159,
  TD-160, TD-161.

## Revision (2026-10-19, after review): Salesforce org safety

- **Never** clicked, on any site: a control inside a Salesforce Screen Flow. Its ancestors are walked up through
  shadow-root hosts, looking for `lightning-flow` / `flowruntime-*`.
- **Never** clicked on a Salesforce Lightning APP URL (`*.lightning.force.com`, `*.my.salesforce.com`,
  `/lightning/`): "Next" / "Finish". On an Experience Cloud site "Next" is still allowed.
- A POST block cannot do this job, because Aura/LWC send reads and writes alike as POST. The README now says
  `BUTTON_EXPLORER_ENABLED` must stay off against production orgs.
- Tests (`tests/buttonExplorer.test.ts`, now 7):
  - the URL classifier and the two deny rules;
  - a real-Chromium page with a `flowruntime-flow` (light DOM) and a `lightning-flow` whose button sits in a
    SHADOW root: all three flow buttons are skipped as "inside a Salesforce Screen Flow", the server counts 0 flow
    clicks, and the one control outside the flow is still clicked.
- No live re-run was made for this change. The explorer never clicked a flow control in the measured runs: there
  were none on these sites.
