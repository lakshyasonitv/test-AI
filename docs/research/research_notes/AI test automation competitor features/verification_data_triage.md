# Verification, test data, failure triage and reporting in test-automation platforms (state as of Oct 2026)

How these notes were gathered: WebFetch failed with DNS errors (`ENOTFOUND applitools.com`,
`ENOTFOUND reportportal.io`), so most findings come from WebSearch result summaries that quote the
pages. Those summaries are paraphrases, not full reads. Three primary sources were read in full from
the vendors' own GitHub doc repositories: ReportPortal (`reportportal/docs`), Playwright
(`microsoft/playwright/docs/src`) and MDN (`mdn/content`). For those, both the raw source and the
published page are cited. The session's shared web-search budget (200 per turn) ran out before
Jira/ADO integrations, mabl insight types and a few other gaps could be researched; they are listed
under **Gaps**.

Every finding carries a source-type tag:
- **[Docs]**: official product documentation or help center.
- **[Vendor]**: vendor marketing, blog or press release.
- **[3P]**: third party. Competitor-written material says so explicitly.

---

## 1. Verification: visual AI, AI/semantic assertions, outcome checks, accessibility, expected-outcome inference

### Takeaway
The vendors avoid false passes in two ways. Some use **deterministic comparison against a stored reference**, such as an Applitools baseline, a mabl learned visual model, or a Playwright ARIA snapshot. Others **narrow what an AI judge is asked to decide**: mabl tells users to keep GenAI assertion prompts strict and single-criterion because vague ones pass on broken pages. Applitools Autonomous keeps LLMs out of runtime entirely. Outcome checks such as API/network status assertions and axe-core accessibility scans are offered as separate, deterministic step types next to the visual and AI checks. None of them replaces the visual and AI checks.

### Cited Findings

**Applitools Eyes: match levels**
- **Strict** is the default. It "detects any meaningful differences that are visible to the human eye" and suits static pages. **Layout** compares structure and position but ignores text and image changes. Applitools warns that under Layout the tool "will not detect differences if... the news headline or list of products changes." **Exact** is pixel-to-pixel and discouraged. — [Docs](https://applitools.com/docs/eyes/concepts/best-practices/match-levels); [Docs](https://applitools.com/tutorials/guides/advanced-use-cases/choosing-match-level)
- **Content** (older SDK docs) compares content and layout but ignores color. Current Storybook docs list **Ignore Colors** in its place, so the naming differs across SDKs and doc versions. — [Docs](https://applitools.com/docs/eyes/sdks/storybook/core-concepts); [Docs](https://applitools.com/tutorials/concepts/best-practices/match-levels)
- **Dynamic** (newer) "automatically detect[s] and suppress[es] diffs due to dynamic data such as emails, dates, credit card numbers." — [Docs, Storybook core concepts](https://applitools.com/docs/eyes/sdks/storybook/core-concepts). A 2025/26 Applitools post also names a "dynamic match level" in its title. I could not read its detail. — [Vendor](https://applitools.com/blog/eyes-autonomous-pdf-testing-conditional-steps-dynamic-match-level/)
- Recommended pattern: apply Strict to the whole page and put **Layout regions** over the dynamic parts. Match levels can be set per region. — [Docs](https://applitools.com/docs/eyes/concepts/best-practices/match-levels)

**Applitools: regions and baseline management**
- **Ignore regions** skip Visual AI comparison in that area. **Floating regions** define a range within which an element may move before it counts as a bug. — [Docs](https://applitools.com/tutorials/guides/advanced-use-cases/match-levels-&-regions)
- A region added to a **step variation** applies only to that variation, not to the baseline. — [Docs](https://applitools.com/docs/features/baseline-variations.html)
- Auto-maintenance:
  - When a user adds a region, Test Manager offers "Apply to other steps in scope": Eyes searches for similar regions in other tests and steps.
  - Automatic region lookup is **disabled by default**.
  - Adding `auto=false` to the results URL turns off auto region lookup and auto accept/reject.
  - Regions are copied to baselines for new browsers and OSes.
  - [Docs/help center](https://help.applitools.com/hc/en-us/articles/360007188871-Automatic-maintenance-auto-adjust-Regions); [Docs](https://applitools.com/tutorials/concepts/reviewing-tests/test-maintenance)

**Applitools: Root Cause Analysis (RCA)**
- Eyes stores the **DOM and CSS for each checkpoint and for each baseline**, and Test Manager diffs them.
- It reports textual changes, CSS property changes, attribute changes, bounding-box changes and tag changes (for example, a button replaced by a link).
- Changed CSS properties are shaded red or green.
- Users can click a diff area, or pick two elements, to compare them.
- RCA is limited to DOM-based web apps.
- [Docs](https://applitools.com/docs/eyes/concepts/reviewing-tests/root-cause-analysis); [Docs](https://applitools.com/docs/topics/test-manager/viewers/root-cause-analysis.html)
- RCA was announced in Dec 2018 ("industry's first automated root cause analysis"). — [3P press coverage of a vendor release](https://devops.com/applitools-introduces-industrys-first-automated-root-cause-analysis-for-developers-and-qa-teams-to-quickly-pinpoint-bugs-within-web-applications); [3P](https://sdtimes.com/test/applitools-root-cause-analysis-pinpoints-css-and-dom-bugs-in-web-applications)

**Applitools: Ultrafast Grid (UFG)**
- The SDK captures a **DOM snapshot** (HTML, CSS and resources) instead of a screenshot. UFG renders it in parallel in containers across browsers and viewports, then sends the screenshots to Visual AI. Unchanged resources are not re-uploaded. — [Docs](https://applitools.com/tutorials/concepts/test-execution/ultrafast-grid); [Docs](https://applitools.com/tutorials/guides/advanced-use-cases/ultrafast-grid)
- The speed and reliability claims ("containers rather than VMs") are vendor assertions. — [Vendor](https://applitools.com/platform/ultrafast-grid/); [Vendor](https://applitools.com/blog/fast-ui-testing/)

**Applitools Autonomous**
- An LLM turns plain-English steps into executable steps. An "auto-correcting LLM" fixes mistakes and splits complex flows. — [Vendor](https://applitools.com/?p=61068); [Docs](https://applitools.com/docs/autonomous/llm-assisted-test-authoring)
- Steps can check text, numeric values and element visibility. **Logical operators** can combine these conditions, alongside visual checks. — [Vendor](https://applitools.com/platform/autonomous)
- Conditional steps ("if"/"unless") skip a block when the condition is false. The block's steps are marked **Skipped** and the test continues. This comes from a search summary and was not tied to a specific page. — [Vendor](https://applitools.com/blog/eyes-autonomous-pdf-testing-conditional-steps-dynamic-match-level/)
- The crawler can add Visual AI checkpoints to every page under a domain or URL list. — [Vendor](https://applitools.com/platform-overview/)
- **"Deterministic test execution (no LLMs at runtime)":** the LLM is used for authoring and data preparation only. — [Vendor](https://applitools.com/platform-overview/)

**mabl: GenAI Assertions (AI/semantic checks)**
- A GenAI Assertion sends a **screenshot of the target element plus a natural-language description** to an LLM. The LLM returns pass or fail **with an explanation**. — [Docs](https://help.mabl.com/hc/en-us/articles/28913278469140)
- It judges **the screenshot, not the DOM or page source**. Only the part of the element that is visible in the viewport is captured. — [Docs](https://help.mabl.com/hc/en-us/articles/28913278469140)
- **False-pass guidance:** descriptions should be "strict but not overly specific." A vague prompt such as "the page has loaded" **could pass even if a submit button is missing**. Too many criteria are hard to evaluate, so users should split complex assertions into several GenAI Assertions. Users iterate with a "Test assertion" button while authoring. — [Docs](https://help.mabl.com/hc/en-us/articles/28810650854292)
- It runs on Google Cloud enterprise AI, and mabl says no customer data is used for training. — [Docs](https://help.mabl.com/hc/en-us/articles/28913278469140)
- Availability conflicts between help articles:
  - The mobile version is described as early access.
  - Another article limits the feature to mabl Core plans, not legacy plans.
  - [Docs](https://help.mabl.com/hc/en-us/articles/29849341100948)
- mabl calls GenAI Assertions its "fastest growing feature in our history." — [Vendor](https://www.mabl.com/blog/genai-assertions-are-mabls-fastest-growing-feature-in-our-history)
- Test Creation Agent:
  - For browser tests it validates outcomes **with GenAI Assertions**.
  - In mobile tests, each task ends with a visual assertion.
  - mabl warns that generation is non-deterministic and English-biased.
  - [Docs](https://help.mabl.com/hc/en-us/articles/31649455424660); [Docs](https://help.mabl.com/hc/en-us/articles/38362436631316)

**mabl: visual change detection**
- A **dynamic visual model** is learned over many plan runs. It ignores areas that change often, such as ads, product listings, video and animation, and raises a "visual change" insight only for changes outside those areas. — [Docs](https://help.mabl.com/hc/en-us/articles/17781317871508); [Docs](https://api.help.mabl.com/docs/visual-change-detection)
- **A visual change is a warning, not a test failure.** — [Docs](https://api.help.mabl.com/docs/visual-change-detection)
- With learning off, mabl compares against the **previous plan run in the same environment**. Pixel diffs are grouped and **tied to DOM information**. — [Docs](https://api.help.mabl.com/docs/visual-change-detection-browser-tests)
- Sources disagree on how many runs training takes:
  - "At least four runs." — [Vendor](https://mabl.com/blog/modern-dev-talk-episode-3)
  - "Fixed baseline after ~10 test executions." — [Vendor course](https://university.mabl.com/how-to-visual-testing/16074)
  - "From the first ten runs to a much higher amount," depending on how dynamic the site is. — [Vendor](https://www.mabl.com/blog/the-truth-about-ml-in-test-automation)
- An "Update Baseline" button rebaselines one step or all steps. Visual smoke tests do not support learning dynamic regions. — [Docs](https://help.mabl.com/docs/visual-smoke-test-setup)

**mabl: outcome checks beneath the UI**
- **API steps inside browser tests** support GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS.
  - A new API step automatically gets an assertion that the **status code equals 200**.
  - Users can also assert on status, size, headers and body (equals / contains / is present).
  - Requests can reference variables with `{{@var}}`.
  - [Docs](https://help.mabl.com/docs/api-steps); [Docs](https://api.help.mabl.com/docs/api-response-validation)
- Separate **cookie assertions** cover value, domain, path, expiry, httpOnly and secure. — [Docs](https://help.mabl.com/hc/en-us/articles/49290835549204)
- I found no mabl doc for asserting on the browser's own network traffic during a UI action (see Gaps).

**mabl: accessibility (axe-core)**
- An Accessibility step can target the current frame (default), the full page or an element.
  - It fails the step **by violation severity**.
  - Advanced settings select axe tags or rules.
  - Default: axe-core's default configuration, which runs all rules except "experimental" ones.
  - **WCAG tags are not cumulative.** WCAG 2.0 AA does not include Level A, so both tags must be listed.
  - Results show violations, incomplete, inapplicable and passing checks.
  - mabl itself says automated checks "are not enough to ensure that your application is accessible."
  - [Docs](https://help.mabl.com/hc/en-us/articles/17688147503764); [Docs](https://api.help.mabl.com/docs/accessibility-testing-overview); [Docs](https://api.help.mabl.com/docs/getting-started-with-accessibility-testing)
- Plan availability is stated inconsistently ("Growth and Enterprise" vs. also "trial users"). — same docs

**mabl: performance**
- Page load time is tracked for every test. **Speed Index** is the headline metric, measured on Chrome and Edge only.
- The Performance tab charts the last 90 days.
- "Page load time high/low" insights fire when a run is "significantly longer than the time predicted based on past observations."
- Insights can be sent to Slack or Teams.
- [Docs](https://help.mabl.com/docs/insight-types); [Docs](https://api.help.mabl.com/docs/monitor-app-performance-over-time); [Docs](https://api.help.mabl.com/docs/optimizing-test-performance); [Vendor](https://www.mabl.com/performance-regression-testing)

**Playwright: deterministic primitives**
- Auto-retrying web-first assertions include:
  - `toHaveURL`, `toHaveTitle`, `toHaveText`, `toContainText`, `toHaveValue`, `toHaveAttribute`, `toHaveCount`
  - `toHaveAccessibleName`, `toHaveAccessibleDescription`, `toHaveRole`
  - `toMatchAriaSnapshot` (page or locator), `toHaveScreenshot`
  - `expect(response).toBeOK()`
  - The default timeout is 5 s.
  - `expect.poll` / `expect.toPass` wrap arbitrary async checks. `toPass` defaults to timeout 0.
  - `expect.soft` keeps the test running after a failed assertion and collects all failures.
  - [Docs, raw source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/test-assertions-js.md) (published at playwright.dev/docs/test-assertions)
- **ARIA snapshots** compare the accessibility tree against a YAML template.
  - **Partial matching** is supported: omit attributes, names or children.
  - `/children: contain | equal | deep-equal` sets strictness, per node or globally in config.
  - Accessible names and text accept **regex** (`- heading /Issues \d+/`).
  - The docs advise snapshots for broad structure and plain assertions for precise conditions.
  - [Docs, raw source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/aria-snapshots.md)
- **Network outcomes:**
  - `page.waitForResponse(glob | regex | predicate)` waits for the response that follows an action.
  - `page.route` / `context.route` mock or abort requests.
  - HAR files can be replayed.
  - [Docs, raw source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/network.md)

**Expected-outcome inference**
- Functionize's Diagnose Agent shows **"expected versus actual outcomes"** for the failing step. — [Docs](https://support.functionize.com/hc/en-us/articles/33000500963735-Using-Diagnose-Agent)
- mabl's Test Creation Agent adds a GenAI Assertion at the end of each generated flow or task (see above). These were the only explicit "expected outcome" mechanisms I found.

### Inferences
- Both AI-assertion vendors keep the AI out of the pass/fail path, or treat its verdict as subordinate:
  - mabl tells users to tighten prompts and split criteria.
  - Applitools runs no LLM at execution time.
  - mabl reports visual changes as warnings, not failures.
  This matches our D-06/D-27 stance. An LLM-vision verdict should be advisory, or confined to a narrowly scoped, single-criterion check.
- mabl's own example ("the page has loaded" passes with a missing button) is exactly the vacuous-assertion class we see (`url_contains "#"`, a stalled flow passing). No vendor documents an automatic **vacuity check** for this, i.e. asserting that the check would have failed before the action. Their mitigation is authoring guidance. A structural vacuity check would be stronger than what the market documents.
- Applitools' Layout level explicitly accepts missing content changes as the price of stability. Any "dynamic region" approach we adopt trades away detection, so it should be scoped to regions, not whole pages.

### Gaps
- Applitools **Dynamic** match level internals (how it detects "dynamic data"), and whether it is GA on all SDKs. Only one official sentence was found.
- Applitools accessibility (contrast and other checks) was not researched because the search budget ran out.
- mabl assertions on in-flight browser network requests, and any **database-check** step: no source found. No vendor in scope documented first-class DB assertions in the results I obtained.
- Testim and Katalon assertion mechanisms (smart/AI assertions): not found in results.
- The exact syntax of Applitools Autonomous "verify" steps was not found.

---

## 2. Test data: synthetic generation, data-driven and combinatorial testing, DOM constraint inference, uniqueness, cleanup, OTP inboxes

### Takeaway
Commercial tools generate data in three ways:
- **Scripted randomization** (Testim JS expressions, Testsigma random types).
- **LLM generation from a plain-English description, prepared ahead of execution** (Applitools Autonomous).
- **Managed pools of records with consume/release semantics** (Tosca TDS).

Combinatorial coverage is handled with **all-pairs / orthogonal / linear-expansion** generators (ACCELQ, Tosca). Per-run uniqueness for email and SMS comes from **ephemeral inboxes and numbers**, filtered by recipient and time (mabl Mailbox, Mailosaur). No vendor document I found describes **inferring field constraints from the DOM** to generate valid data. The browser's own Constraint Validation API (MDN) provides the deterministic primitives for it.

### Cited Findings

**LLM and synthetic generation**
- Applitools Autonomous "LLM-assisted test data generation": users describe the data (names, emails, addresses, structured records) in plain English. Autonomous **generates it in advance and selects it at runtime**, aimed at sign-ups, input validation and form submissions. — [Docs](https://applitools.com/docs/autonomous/content/topics/llm-assisted_test_data_generation.htm)
  - The Autonomous 2.2 post's example is "Submit the form using random data for 90's TV dads." It says data is produced "at runtime," with fresh values per run. — [Vendor](https://applitools.com/blog/introducing-autonomous-2-2/)
  - **Conflict:** "in advance" (docs) vs. "at runtime" (blog). The platform overview says datasets are generated ahead of time "so test execution remains fast and predictable." — [Vendor](https://applitools.com/platform-overview/)
- Testim: a set-text step can take any **JS expression** instead of the recorded literal, for example `Math.round(Math.random()*100000)+"@email.com"`. A value is reused later by storing it in a variable: shared-step params, or `exports.myVar = ...` from a custom JS step. — [Docs](https://help.testim.io/docs/generate-random-data-with-js); [Docs (Tricentis)](https://docs.tricentis.com/testim/content/guides/generate-random-data-with-js.htm)
- Testsigma (adjacent vendor) has a built-in **Random** test-data type for numbers, emails and passwords. — [Docs](https://testsigma.com/docs/test-data/types/overview/)
- Tricentis + Synthesized integration (Aug 2026): Tosca test cases or the Tosca Test Data Service **call Synthesized APIs before execution** to generate, mask or subset data. Masking, subsetting, synthetic generation and time-slicing are claimed. The "up to 90%" effort reduction is a vendor claim. — [Vendor (partner)](https://synthesized.io/post/synthesized-deep-integration-with-tosca); [Vendor (partner)](https://www.synthesized.io/post/how-to-automate-realistic-sap-test-data-on-demand-for-tricentis-tosca)
- Tricentis markets Tosca TDM as instantly provisioning on-demand test data and as "GDPR compliant." The page I saw described no built-in synthetic generator. — [Vendor](https://www.tricentis.com/products/automate-continuous-testing-tosca/test-data-management)

**Data pools: consume and release (stateful data)**
- Tosca Test Data Service:
  - Records used in a run are **marked consumed and released when the run ends**.
  - The `TestData - Expert` module has **ConsumeRecord / UnconsumeRecord**.
  - A consumed record appears locked in the TDM web app.
  - For data that many tests share (for example, payment cards), exclusive consumption breaks distributed runs. The docs suggest a **ReadOnly** property instead.
  - Deletes through the Expert module are irreversible.
  - [Docs](https://documentation.tricentis.com/tosca/1320/en/content/test_data_management/tds_expert_module.htm); [Docs](https://documentation.tricentis.com/tosca/1300/en/content/test_data_management/tds_introduction.htm)

**Data-driven and combinatorial testing**
- ACCELQ: **Test Cases are data-driven instances of a Scenario**. The Scenario holds the flow and the Test Cases hold the data.
  - A parameter can be per-row, fixed across rows, or linked to Global Properties.
  - Parameters with a Data Type or Data List take part in generation.
  - The system "brings out **minimal number of permutations** required to cover each parameter value using **all-pair analysis**."
  - [Docs](https://support.accelq.com/hc/en-us/articles/41589227364237-Working-with-Test-Cases-in-ACCELQ); [Docs](https://support.accelq.com/hc/en-us/articles/115007511007-Support-for-data-driven-testing-ability-to-execute-same-Scenario-with-multiple-data-sets)
- Tosca TestCase-Design combinatorics:
  - Methods: **All combinations, Orthogonal, Pairwise, Linear expansion [Relations], Linear expansion**.
  - Orthogonal yields the fewest combinations; it only requires each value to appear at least once.
  - **Linear expansion** starts from a straight-through case and **changes one attribute at a time**. It produces slightly more tests, and failures trace to a single attribute.
  - The default cap is **1000 instance combinations**, configurable in ToscaCommander.config.
  - [Docs](https://docs.tricentis.com/tosca-2026.1/en-us/content/testcase_design/instance_combinatorics.htm); [Docs](https://docs.tricentis.com/tosca-cloud/en-us/content/testcase_design/testcase_instances.htm)
- Background: pairwise testing covers all two-way factor interactions. Orthogonal arrays cover every combination an equal number of times. — [3P, Microsoft Research paper](https://microsoft.com/en-us/research/wp-content/uploads/2013/04/OnUseOfCoverageMetricsInAssessingEffectivenessOfCombinatorialTestDesigns.pdf)

**Field-constraint primitives (browser standard)**
- `ValidityState` explains why a field's value is invalid:
  - `valueMissing` (`required`)
  - `typeMismatch` (`type=email|url` syntax)
  - `patternMismatch` (`pattern`)
  - `rangeOverflow` / `rangeUnderflow` (`max` / `min`)
  - `stepMismatch` (`step`)
  - `tooLong` / `tooShort` (`maxlength` / `minlength`). `tooLong` is never true in Gecko because typing past maxlength is blocked.
  - `badInput`, `customError` (set by page JS via `setCustomValidity`)
  - `valid`
  - [Docs (MDN), raw source](https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/validitystate/index.md) (published at developer.mozilla.org/en-US/docs/Web/API/ValidityState)
- MDN's constraint-validation guide lists the semantic input types and the validation attributes (`pattern`, `min`, `max`, `step`, `minlength`, `maxlength`, `required`), along with the violation each one causes. — [Docs (MDN), raw source](https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/html/guides/constraint_validation/index.md)
- libphonenumber:
  - `getExampleNumber(region)` and `getExampleNumberForType(region, type)` return a **valid example number** for a region.
  - C++ `GetInvalidExampleNumber` derives a deliberately invalid number for negative tests.
  - Unsupported regions return null.
  - [3P docs (PHP port)](https://libphonenumber-for-php.readthedocs.io/en/latest/PhoneNumberUtil/); [3P (source mirror)](https://chromium.googlesource.com/external/libphonenumber/+/refs/heads/getExampleNumberAndParseDocUpdates)

**Unique data per run; email and SMS OTP**
- mabl Mailbox:
  - **Temporary addresses** are generated as variables, differ on every run, and do not persist after the run.
  - **Permanent addresses** persist and suit password recovery and email MFA. Limits are 100 per customer workspace and 20 in trials.
  - The Mailbox step checks received mail.
  - [Docs](https://help.mabl.com/hc/en-us/articles/19078165664404); [Docs](https://help.mabl.com/hc/en-us/articles/19150099707284)
- Mailosaur SMS: send the SMS to a dedicated virtual number, then query by `sentTo` and assert. — [Docs](https://mailosaur.com/docs/sms-testing); [Docs](https://mailosaur.com/docs/automation/playwright/sms-testing)
  - The pool of virtual numbers is limited, so search criteria matter. — [Vendor](https://mailosaur.com/blog/automate-2fa-mfa-testing-playwright)
  - Third-party advice is to filter by unique recipient **plus a received-after timestamp**, so parallel or repeated CI runs don't read each other's codes. — [3P](https://qaskills.sh/blog/mailosaur-email-sms-testing-guide)
- Cleanup and isolation advice from Currents: avoid fixed waits, keep tests isolated, and "use clean data before each test." — [Docs](https://docs.currents.dev/tests/flaky-tests)

### Inferences
- The gap between "LLM invents a phone number or budget" and "site validation rejects it" is closed by **checking the generated value against the field's own constraints** before submitting. The browser already exposes this deterministically through `checkValidity()` / `ValidityState`. That is a structural check, not a prompt rule, in line with this project's central design rule.
- HTML attributes do not capture JS-only validation (`customError`, framework validators). A post-fill or post-submit check is still needed: look for `aria-invalid` or a visible error near the field. A rejection should then be reported as a **data** failure, not a product bug.
- Applitools' choice to generate data **before** execution matches our disk-cache and determinism stance. The cache key would need to include the field-constraint signature (`CLAUDE.md` cache-key rule).
- Tosca's consume/release model is the right pattern for shared accounts: our `${env:...}` credential walks are one-at-a-time, and parallel runs on one account collide.

### Gaps
- No vendor document found on **DOM-attribute-driven data inference** (type/pattern/min/max/placeholder → value). It may exist under other names. Search budget ran out before mabl "data tables" / AI data generation and Katalon data features could be checked.
- Locale-aware format generators (Faker locales, postal codes) were not researched from primary sources.
- Data cleanup and teardown features of the vendors (beyond Tosca consume/release) were not found.

---

## 3. Failure triage: categories, ML and heuristic auto-analysis, flaky detection, grouping, first failure, commit linking

### Takeaway
The market has converged on a **five-bucket defect taxonomy**: Product Bug / Automation (test) Bug / System or Environment Issue / No Defect / To Investigate. It is assigned by **similarity to past human-labelled failures**:
- ReportPortal: OpenSearch TF-IDF candidates, then an XGBoost classifier with a ≥50% probability threshold.
- BrowserStack: learns from the team's manual tags.
- mabl: an LLM agent picking from built-in or custom reasons, with manual labels taking precedence.

Flakiness is a **separate, history-based tag**, not a category: retry-pass within a run, or a pass/fail flip rate over the last N runs. Grouping is done on **normalized error text** (Unique Errors) plus **regex pattern rules**.

### Cited Findings

**ReportPortal Auto-Analysis (AA): the most fully documented mechanism**
- AA sets a **defect type, a bug-tracker (BTS) link and a comment** on each failed item. It is "based on previous user-investigated results using Machine Learning." It runs as an **OpenSearch** index plus an **Analyzer** service. — [Docs, raw source](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/AutoAnalysisOfLaunches.mdx) (published at reportportal.io/docs/analysis/AutoAnalysisOfLaunches/)
- Indexing:
  - Only logs at **ERROR level or above** (level ≥ 40000) are indexed, with item ID, issue type, an analyzed-by-user/RP flag, launch name and ID, and test case ID.
  - Small logs (1–2 lines, ≤100 words) are merged.
  - Preprocessing **extracts the error message, stacktrace, numbers, exceptions, URLs, paths and parameters** into separate fields.
  - Items from Debug-mode launches are excluded.
  - Source: same doc.
- Candidate search:
  - Message similarity is mandatory.
  - Matches are boosted by same launch name, same UID, manual analysis, error message and same numbers.
  - Terms are weighted by TF-IDF.
  - The **top 10** results per log are regrouped by defect type, keeping the best representative of each group.
  - Ties are broken by recency.
  - Source: same doc.
- Decision:
  - An **XGBoost** model with about 30 features (share of candidates with each defect type, min/max/mean scores, cosine similarity of message/stacktrace/URL/path vectors, probability from a Random Forest on TF-IDF) gives a probability per defect type.
  - The top type is applied **only if its probability is ≥ 50%**.
  - The best representative's comment and BTS link are copied.
  - Source: same doc.
- Settings:
  - **Base for analysis** has five options: all previous launches / current + previous with the same name / previous with the same name / only the previous launch with the same name / only the current launch.
  - The **"Defect assignment based on the longest retry"** option analyzes the retry with the most passed nested steps before the first failure, instead of the latest one.
  - "Ignore in AA" removes an item from the index.
  - Auto-analyzed items get an **AA** label.
  - Source: same doc.
- **ML Suggestions** run every time the "Make decision" dialog opens:
  - XGBoost with about 40 features.
  - Candidates at ≤40% are dropped.
  - Near-duplicates (≥98% message similarity) are removed.
  - At most **5** suggestions are shown, grouped as **SAME (100%) / HIGH (70–99.9%) / LOW (40–69.9%)**.
  - Applying one copies its defect type, BTS link and comment.
  - [Docs, raw source](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/MLSuggestions.md)
- **Unique Error analysis** (since v5.7, on by default):
  - Lists every unique error in a launch with a **"MATCHED TESTS"** count, sorted by frequency.
  - Small error logs may be merged.
  - Gives ML suggestions per group.
  - Feeds the **"New Errors" Quality Gate rule**.
  - [Docs, raw source](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/UniqueErrorAnalysis.mdx)
  - A bulk-triage workflow lets users link an existing issue or post a new one per group. For example, "with 20 failures, you might see 8 errors instead of 20." — [Vendor](https://reportportal.io/blog/reportportal-handbook/)
- **Pattern Analysis:**
  - Rules are **string or regex** matched against error logs. Matching items get a **PA** label and the pattern name.
  - It runs **before** AA, so a known pattern is tagged first.
  - On by default.
  - Launch-finish PA only processes "To Investigate" items. **Immediate PA** (v24.1) handles any issue type.
  - [Docs, raw source](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/PatternAnalysis.mdx); [Docs](https://reportportal.io/docs/analysis/ImmediatePatternAnalysis/)
- **Immediate AA** (v24.1) analyzes failed steps while the launch is still running. It is triggered by an `immediateAutoAnalysis` attribute on the step and requires logs. — [Docs, raw source](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/ImmediateAutoAnalysis.mdx)
- A 2026 ReportPortal post proposes pairing AA with an **LLM assistant through ReportPortal MCP**. AA handles failures that have historical precedent; the LLM handles failures "that require deeper reasoning or do not yet have enough historical context." — [Vendor](https://reportportal.io/blog/dont-analyze-the-same-failure-twice-smarter-ai-defect-triage-with-reportportal/). This is an add-on pattern, not a documented built-in. InfoQ coverage, Mar 2025: [3P](https://www.infoq.com/news/2025/03/AI-analysis-automated-test)
- Defect types named across sources: To Investigate, Product Bug, Automation Bug, System Issue, No Defect. Custom defect types are recommended as a best practice. — [Vendor](https://reportportal.io/blog/auto-analysis-feature-best-practices/); [Vendor](https://reportportal.io/blog/reportportal-handbook/)

**BrowserStack Test Reporting & Analytics (formerly Test Observability)**
- **Smart Tags** (all on by default and configurable): Flaky, Always Failing, New Failure, Performance Anomaly.
  - **New Failure** (default): fails with a **new error for the first time in the last 5 runs**.
  - **Always Failing** (default): fails with the **same error in the last 5 runs**.
  - **Flaky** (default) applies if either rule holds:
    - (a) the test **passes on a retry in the same run**, checked over the last **10** runs (configurable 0–30);
    - (b) its pass/fail status **flips more than 50%** in the last **10** runs. Both the percentage and N are configurable, with N up to 30.
  - [Docs](https://www.browserstack.com/docs/test-reporting-and-analytics/features/smart-tags)
- **Auto Failure Analysis:**
  - Categories: Product Bug, Automation Bug, Environment Issue, No Defect, To Be Investigated.
  - It is **trained on the team's own manual tags**, and accuracy improves as more failures are tagged. Custom sub-categories are allowed.
  - It runs after each build only if the build has failures, the project had prior failures, **and** some were manually tagged.
  - [Docs](https://www.browserstack.com/docs/test-reporting-and-analytics/features/auto-failure-analysis); [Vendor](https://www.browserstack.com/test-observability)
- A separate **Test Failure Analysis AI agent** (needs BrowserStack AI enabled) uses logs, history and **similar failures** to categorize a failure as a product, environment or automation bug. — [Docs](https://www.browserstack.com/docs/test-reporting-and-analytics/agents/test-failure-analysis); [Vendor release note](https://www.browserstack.com/release-notes/en/new-debug-faster-with-the-test-failure-analysis-ai-agent-LWSodquR)

**mabl Auto Test Failure Analysis (Auto TFA)**
- When a test fails, mabl sends the test output to an LLM and returns "a succinct explanation." It is GA for browser, mobile and API tests and requires the Advanced AI add-on. — [Docs](https://help.mabl.com/hc/en-us/articles/39203892679060)
- The API exposes a `failure_analysis` object with `headline`, `summary` and `failure_category_id`. Plan-level analysis covers which tests failed and why; plan runs from before June 2025 analyze at most 10 failed tests. — [Docs](https://help.mabl.com/hc/en-us/articles/38327846952212)
- **Automatic failure categorization** (release note 2026-07-10):
  - Opt-in for existing workspaces; on by default for workspaces created after 17 June 2026.
  - The agent picks a **built-in reason or a team-defined custom reason**, and custom reasons carry **guidelines** that steer the choice.
  - **Manual assignments take precedence and are never overwritten.**
  - [Docs](https://help.mabl.com/hc/en-us/articles/50902973104916-2026-07-10-Automatic-failure-categorization)
  - The full built-in reason list was not visible; only "regression" was seen.

**Katalon True Platform / TestOps**
- **Probabilistic Flakiness Score (PFS)** is computed from **pass-to-fail transition patterns** in each test's history.
  - The Test Case Health report buckets tests as Stable / Potentially Flaky / Highly Flaky / Uncategorized (insufficient data).
  - Smart tags: **flaky, new failure, always fail, slow**.
  - [Docs](https://docs.katalon.com/katalon-platform/analytics/test-results-failures/investigate-flaky-tests); [Docs](https://docs.katalon.com/katalon-platform/analyze/reports/test-case-status-analysis-report)
- Documented triage order:
  - Check flakiness first for anything tagged flaky.
  - "New failure" or a high historical pass rate points to a recent code change.
  - Environment issues go to DevOps.
  - AI summaries are used to share findings.
  - [Docs](https://docs.katalon.com/katalon-platform/analytics/test-results-failures/investigate-failures)
- The Test Failure Analysis report is a failure-frequency histogram. Failure patterns become clearer with at least 10–20 failures. — [Docs](https://docs.katalon.com/katalon-platform/analyze/reports/view-test-failure-analysis-report); [Docs](https://docs.katalon.com/katalon-platform/analytics/test-results-failures/analyze-failure-patterns)
- True Platform (April 2026) is built around six AI agents, including a **Root Cause Analyzer** and a **Bug Reporter**. The agent list comes from a third-party index. — [3P](https://qaskills.sh/blog/katalon-true-platform-ai-agents-2026); [Docs, AI Assistant](https://docs.katalon.com/katalon-platform/katalon-ai-assistant)
- I found **no** Katalon doc describing automatic failure-category classification. Only a competitor (TestDino) markets "Smart Failure Labels." Trunk, also a competitor, says flakiness detection isn't Katalon's focus. — [3P, competitor](https://trunk.io/compare/trunk-vs-katalon-testops)

**Testim (Tricentis)**
- Testim describes its root-cause analysis as telling **application bug vs. outdated test vs. network delay**. Tools listed:
  - step-by-step screenshots
  - **side-by-side comparison with the last passing run**
  - parsed console logs at the failing step
  - downloadable **HAR** network files
  - **reason-code tagging** with trends per suite
  - **Low confidence:** this came from a search summary attributing it to a testim.io marketing section. The only testim.io URL returned was [this page](https://www.testim.io/?p=3372), whose title did not match, so verify before relying on it. No official Testim help doc on RCA or insights was returned.

**Functionize**
- **Diagnose Agent** (after a run with at least one failed step):
  - Shows the failing step, **expected vs. actual outcome**, and likely root-cause indicators: mismatched text, unexpected UI change, timing.
  - Suggests fixes.
  - Lets users train the AI with structured feedback.
  - [Docs](https://support.functionize.com/hc/en-us/articles/33000500963735-Using-Diagnose-Agent)
- Debugging:
  - **Four screenshots per action.**
  - **Anomalous Attribute Tags** highlight which element attributes changed compared with previous runs.
  - Live Debug on a cloud VM.
  - "Force Fail" retrains the ML.
  - [Docs](https://support.functionize.com/hc/en-us/articles/33000419162263-Debugging-Failed-Tests)
- RCA design: "the failing action often is not the true cause; the root cause may have occurred several steps earlier." It combines a **rule-based expert system with ML**. SmartFix suggests ranked alternative elements when an element can't be found. — [Vendor](https://www.functionize.com/blog/functionize-root-cause-analysis-self-heal); [Vendor](https://www.functionize.com/smartfix)

**Currents (Playwright dashboard)**
- The **Errors Explorer** lists the most frequent errors, sortable by date, tags, author and branch. Each error shows the tests it hit most, its branches and its **last 10 executions**. The grouping logic is not documented in what I found. — [Docs](https://docs.currents.dev/insights/test-suite-performance-explorer/errors-explorer)
- `failOnFlakyTests`: Playwright ≥1.52 can exit non-zero when a test is flaky, and the Currents wrapper supports it from v1.12.3. — [Docs](https://docs.currents.dev/tests/flaky-tests)
- Currents' flaky detection reportedly relies on **Playwright's own retry** outcome (fail then pass = flaky), with quarantine. This is a third-party description. — [3P, competitor](https://testdino.com/blog/flaky-test-detection)

**Playwright (baseline semantics)**
- With retries on, a test is **"flaky"** if it failed first and then passed on retry, and **"failed"** if it failed every retry. `testInfo.retry` lets code clean server state before a retry. Serial-mode groups retry as a whole. — [Docs, raw source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/test-retries-js.md)

**Adjacent vendors (useful patterns)**
- Perfecto side-by-side compares the failed step with the **same step in the last successful run**, but only when script, capabilities and steps up to the failure match. Its visual RCA analyzes the last screenshot before the error. — [Docs](https://help.perfecto.io/perfecto-help/content/perfecto/test-analysis/str-identify-test-failure-cause.htm)
- Testsigma "Compare Steps" compares the failing step's screenshot and element source with an earlier run. — [Docs](https://testsigma.com/docs/v2/run-tests/debug/)
- TestDino (a competitor) sub-categorizes flaky tests as Timing Related / Environment Dependent / Network Dependent / Assertion Intermittent. — [3P](https://docs.testdino.com/guides/flaky-tests/root-cause-analysis)

### Inferences
- **Category vs. mechanism.** All vendors put a **business-level** category on top (product / automation / environment / no defect / investigate). Our `classify.ts` categories (`element_missing`, `timeout`, `assertion_failed`, ...) are **mechanical** symptoms that sit underneath it. The two are orthogonal: a `timeout` can be any of the five.
- **"To Investigate" is the honest default.** ReportPortal applies a category only above 50% probability. BrowserStack does nothing without prior human tags. mabl never overwrites a human label. None of them forces a guess. Our "truncated/unconfirmed" cases map naturally to an explicit To-Investigate bucket rather than pass or fail.
- **Learning from human decisions is the common core.** ReportPortal's similarity pipeline (normalize log → extract fields → nearest neighbours → threshold) can be reproduced at small scale without ML: a normalized error signature (strip numbers, IDs, URLs) joined against past labelled failures.
- **First-failure, flaky and always-failing need run history keyed by a stable test identity.** Every vendor's flaky rule is a window over N prior runs of the same test. Our runs are per request + URL, so the precondition is a stable case signature.

### Gaps
- BrowserStack's Auto Failure Analysis algorithm (features, threshold) is not documented in what I found.
- mabl's built-in failure-reason list was not found.
- Currents' error-grouping logic and any Currents AI features were not found.
- **Linking failures to commits** (git SHA / author, "suspect commit") was found only indirectly: Currents filters errors by author and branch, and Katalon says "new failure" suggests a recent code change. No vendor's commit-blame mechanism was documented in the results.
- ACCELQ "Analyzer" / root-cause features: no source found under that name.
- Testim's official RCA and insights docs were not returned by search.

---

## 4. Reporting: report contents, Jira/ADO integration, dashboards, history and trends

### Takeaway
The reference report is Playwright's trace:
- per-action **Before / Action / After DOM snapshots**, locator and duration
- a screencast film strip
- console, network and source panels, scoped to the selected actions
- errors marked on the timeline
- attachments

Commercial tools add these on top:
- **comparison with the last passing run** (Testim, Perfecto, Testsigma)
- **DOM/CSS diffs** (Applitools RCA)
- **changed-attribute flags** (Functionize)
- **HAR** downloads (Testim)
- a **headline + summary + category** explanation (mabl)
- **smart tags and trend dashboards** (BrowserStack, Katalon, Currents)
- **grouped unique errors with bug-tracker links** (ReportPortal)

### Cited Findings
- **Playwright Trace Viewer:**
  - The Actions tab shows the locator and duration of every action.
  - **Before** (when the action is called), **Action** (at input, highlighting the target node and click position) and **After** snapshots are kept.
  - A screencast film strip is recorded when screenshots are on (the default).
  - Console and network logs filter to the selected actions.
  - Also available: Source, Call, Log (Playwright's internal waits), **Errors** (a red line on the timeline at the failure), Attachments and Metadata.
  - Traces open locally or at trace.playwright.dev, including by URL to CI storage.
  - [Docs, raw source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/trace-viewer.md) (published at playwright.dev/docs/trace-viewer)
- Recording modes:
  - `trace`: `off | on | retain-on-failure | on-first-retry | on-all-retries`. `retain-on-failure` records every test but keeps only failed ones, which is useful without retries.
  - `screenshot`: `off | on | only-on-failure`.
  - `video`: `off | on | retain-on-failure | on-first-retry`.
  - [Docs, raw source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/test-use-options-js.md); [Docs, raw source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/trace-viewer.md)
- **Playwright UI mode:**
  - Time-travel trace with a timeline.
  - **Pop-out DOM snapshot** that can be inspected with DevTools.
  - **Pick locator** with a locator playground.
  - Filter by status or @tag.
  - **Watch mode** re-runs tests on change.
  - [Docs, raw source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/test-ui-mode-js.md)
- **Applitools:** the diff viewer with RCA shows DOM and CSS changes behind a visual diff (see §1). — [Docs](https://applitools.com/docs/eyes/concepts/reviewing-tests/root-cause-analysis)
- **mabl:**
  - Accessibility results appear at step level (violations, incomplete, inapplicable, passes).
  - A Performance tab shows 90-day load-time trends.
  - Insights can go to Slack or Teams.
  - The Auto TFA headline and summary appear on the failed run.
  - [Docs](https://api.help.mabl.com/docs/accessibility-testing-overview); [Docs](https://help.mabl.com/docs/insight-types); [Docs](https://help.mabl.com/hc/en-us/articles/39203892679060)
- **Functionize:** four screenshots per action, Anomalous Attribute Tags, and the Diagnose Agent's expected-vs-actual panel. — [Docs](https://support.functionize.com/hc/en-us/articles/33000419162263-Debugging-Failed-Tests)
- **Testim** (low confidence, see §3): step screenshots, side-by-side with the last passing run, console logs at the failing step, and a HAR download. — [Vendor, unverified URL](https://www.testim.io/?p=3372)
- **ReportPortal:**
  - The AA and ML Suggestions results copy **BTS (bug-tracker) links** and comments from similar past failures.
  - Unique Errors supports bulk "link existing issue / post new issue."
  - Pattern rules feed a "Most Popular Pattern" widget.
  - The "New Errors" Quality Gate rule can gate a launch.
  - [Docs, raw source](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/AutoAnalysisOfLaunches.mdx); [Docs, raw source](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/PatternAnalysis.mdx); [Vendor](https://reportportal.io/blog/reportportal-handbook/)
- **BrowserStack:** Smart Tags appear on results, along with flakiness dashboards and testing trends. — [Docs](https://www.browserstack.com/docs/test-reporting-and-analytics/features/smart-tags); [Docs](https://www.browserstack.com/docs/test-observability/features/testing-trends)
- **Katalon:** a test-case health report (flakiness buckets), a failure-frequency histogram, AI summaries for sharing, and an AI Assistant that can go from failure analysis to "filing bugs." — [Docs](https://docs.katalon.com/katalon-platform/analyze/reports/test-case-status-analysis-report); [Docs](https://docs.katalon.com/katalon-platform/katalon-ai-assistant)
- **Currents:** Errors Explorer with the last 10 executions per error, and branch/author filters. — [Docs](https://docs.currents.dev/insights/test-suite-performance-explorer/errors-explorer)

### Inferences
- What our HTML report lacks compared with the reference set is mostly **comparative context**: last-passing-run comparison, DOM/attribute diff, and error grouping across cases. It is not raw artifacts, since we already have screenshots and video.
- Playwright's own trace already provides Before/After DOM snapshots plus network and console logs at zero vendor cost. Attaching `trace.zip` (retain-on-failure) to each failed case would match most of what the commercial tools show per step.

### Gaps
- **Jira / Azure DevOps integration specifics** (field mapping, auto-attachments, two-way sync) for mabl, BrowserStack, Applitools, Katalon and ReportPortal were **not researched** because the web-search budget was exhausted. Only ReportPortal's BTS-link copying and bulk issue posting, and Katalon's AI "filing bugs," were confirmed.
- Not researched for the same reason: mabl insight types beyond performance and visual change (for example JS errors, broken links), and the Applitools dashboard and branch-merge workflow.

---

## Adoptable techniques for our pipeline

Each item names the mechanism, the source it comes from, and how it maps onto this codebase:
- IR assertion enum in `src/schema/ir.ts`: `visible | hidden | text_equals | text_contains | url_contains | title_contains | title_equals | enabled | disabled`
- mechanical categories in `src/stages/classify.ts`: `selector_changed, element_missing, element_not_interactable, element_hidden, multiple_matches, detached, timeout, assertion_failed, navigation_error, network, other`

Per `CLAUDE.md`, every item would be a new optional field or route, behind an env flag defaulting to OFF.

**Verification**

1. **Vacuity check: an assertion must be false before its trigger and true after.**
   - At grounding or replay time, evaluate each assertion against the **pre-action** state, i.e. the screen captured before the step that should cause it.
   - If it already holds there, reject or downgrade it as vacuous. This catches `url_contains "#"`, `url_contains` of the starting URL's substring, and `visible` on an element that was always on screen.
   - This is a structural check over captured screens, not text heuristics.
   - Motivation: mabl documents that vague assertions "could pass even if a submit button is missing," and its only mitigation is authoring guidance ([Docs](https://help.mabl.com/hc/en-us/articles/28810650854292)). No vendor documents an automated vacuity check, so this would go beyond the market.
2. **Outcome assertions on network responses.**
   - Add an IR assertion such as `response_ok { urlPattern, method?, status? }`.
   - Compile it to `const r = page.waitForResponse(pattern)` registered *before* the triggering action, then `expect(await r).toBeOK()` or a status check.
   - Ground `urlPattern` against requests actually observed during discovery or replay, not model text.
   - This verifies that a form "submitted" (budget, phone) rather than stalled.
   - Sources: Playwright `waitForResponse` and `toBeOK` ([Docs](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/network.md), [Docs](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/test-assertions-js.md)); mabl's default "status = 200" assertion on API steps ([Docs](https://help.mabl.com/docs/api-steps)).
3. **Role-based message assertions via ARIA snapshot or accessible name.**
   - For "verify the success/error message," emit `expect(locator).toMatchAriaSnapshot()` with a **partial** template (`/children: contain`, regex for dynamic numbers). Alternatively target `getByRole('alert'|'status')` with `toHaveText`.
   - Ground the expected string against the post-action capture, and check it equals the message the request named. This is a structural comparison of the case's expected value against the observed node, not page-prose regex.
   - Source: Playwright ARIA snapshots ([Docs](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/aria-snapshots.md)).
4. **Keep LLM-vision verdicts advisory and single-criterion.**
   - If an LLM judges a screenshot, ask exactly one question per call, require an explanation, and never let it turn a deterministic failure into a pass. Applitools keeps "no LLMs at runtime."
   - Sources: mabl GenAI guidance ([Docs](https://help.mabl.com/hc/en-us/articles/28810650854292)); Applitools deterministic execution ([Vendor](https://applitools.com/platform-overview/)); consistent with `DECISIONS.md` D-06/D-27.
5. **Visual change as a warning, with learned dynamic regions.**
   - Optionally diff step screenshots against the last passing run of the same case. Report differences as **warnings**, not failures.
   - Mask regions that differ between two discovery captures of the same screen. This is a structural "dynamic region" signal, not a regex for dates or emails.
   - Sources: mabl visual change learning and its warning-not-failure rule ([Docs](https://api.help.mabl.com/docs/visual-change-detection)); Applitools Layout regions over dynamic content ([Docs](https://applitools.com/docs/eyes/concepts/best-practices/match-levels)).
6. **Accessibility step.**
   - An optional axe-core scan per case (page or element), with a severity threshold and **explicit WCAG tags**. Tags are not cumulative, so list A and AA separately.
   - Report violations, incomplete, inapplicable and passes. Default: report only, never fail.
   - Source: mabl accessibility ([Docs](https://help.mabl.com/hc/en-us/articles/17688147503764)).

**Test data**

7. **DOM-constraint-driven value generation, verified by the browser.**
   - Discovery already parses inputs. Extend the AppModel field schema with `type`, `required`, `pattern`, `min`, `max`, `step`, `minlength`, `maxlength`, `placeholder`, `inputmode`, `autocomplete`.
   - Generate or adjust the model's proposed value to satisfy them.
   - Before submitting, run `el.checkValidity()` and read `ValidityState` (`patternMismatch`, `rangeOverflow`, `tooLong`, `typeMismatch`, ...). Reject or repair the value deterministically.
   - Source: MDN ValidityState and constraint validation ([Docs](https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/validitystate/index.md)). No vendor documents this end to end.
8. **Locale-valid phone numbers from metadata, not the LLM.**
   - Use libphonenumber `getExampleNumberForType(region, MOBILE)` for valid numbers and `GetInvalidExampleNumber` for negative cases.
   - Infer the region from structural signals: a country `<select>`, the `tel` input's `pattern`/`maxlength`, the `lang` attribute.
   - Source: libphonenumber API ([3P docs](https://libphonenumber-for-php.readthedocs.io/en/latest/PhoneNumberUtil/)).
9. **Generate data before execution; cache it with the constraint signature in the key.**
   - LLM data generation belongs at authoring time. The executor stays LLM-free.
   - Source: Applitools Autonomous data generated "in advance" ([Docs](https://applitools.com/docs/autonomous/content/topics/llm-assisted_test_data_generation.htm)). The cache-key rule is in `CLAUDE.md` / TD-22.
10. **Unique-per-run values and inboxes.**
    - Suffix emails and usernames with the run ID (Testim's JS-expression pattern, [Docs](https://help.testim.io/docs/generate-random-data-with-js)).
    - For email/SMS OTP, use an ephemeral inbox or number per run, filtered by recipient **and** a received-after timestamp, and extract the code with a narrow regex. The OTP itself never touches disk, consistent with the credentials rule.
    - Sources: mabl Mailbox temporary addresses ([Docs](https://help.mabl.com/hc/en-us/articles/19078165664404)); Mailosaur `sentTo` ([Docs](https://mailosaur.com/docs/sms-testing)); timestamp filter ([3P](https://qaskills.sh/blog/mailosaur-email-sms-testing-guide)).
11. **Consume/release locks for shared test accounts.**
    - Before a walk, take an exclusive lease on a credential set and release it at the end. Mark sets that are safe to share as read-only.
    - Source: Tosca TDS ConsumeRecord/UnconsumeRecord and ReadOnly ([Docs](https://documentation.tricentis.com/tosca/1320/en/content/test_data_management/tds_expert_module.htm)).
12. **Data variants by linear expansion first, pairwise second.**
    - For a form case, generate the valid "straight-through" values, then variants that **change one field at a time**, including boundary values from `min`/`max`/`maxlength`. A failure then points to a single field.
    - Use all-pairs only when there are several enumerated fields (selects, radios).
    - Sources: Tosca linear expansion ([Docs](https://docs.tricentis.com/tosca-cloud/en-us/content/testcase_design/testcase_instances.htm)); ACCELQ all-pairs ([Docs](https://support.accelq.com/hc/en-us/articles/41589227364237-Working-with-Test-Cases-in-ACCELQ)).

**Failure triage**

13. **Two-level taxonomy.**
    - Add a business-level `defectType` over the existing mechanical `category`: `product_bug | test_issue | environment | data_rejected | no_defect | to_investigate`. Default to `to_investigate`.
    - `data_rejected` comes from a structural signal: `aria-invalid="true"` or a `ValidityState` failure on a field the case filled. It covers the phone and budget problem.
    - Sources: ReportPortal and BrowserStack five-bucket taxonomy ([Docs](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/AutoAnalysisOfLaunches.mdx), [Docs](https://www.browserstack.com/docs/test-reporting-and-analytics/features/auto-failure-analysis)); custom reasons with guidelines ([Docs, mabl](https://help.mabl.com/hc/en-us/articles/50902973104916-2026-07-10-Automatic-failure-categorization)).
14. **Treat "truncated/unconfirmed" as `to_investigate`, never as pass.**
    - Report it in its own bucket. Use `expect.soft` so that a later assertion still runs and reports.
    - Sources: ReportPortal "To Investigate" default and its ≥50% threshold ([Docs](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/AutoAnalysisOfLaunches.mdx)); Playwright soft assertions ([Docs](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/test-assertions-js.md)). See also TD-101.
15. **Normalized error signatures and "Unique Errors" grouping.**
    - Normalize each failure's error text: strip numbers, IDs, URLs, quoted strings and selector values into separate fields, like ReportPortal's preprocessing. Hash what remains.
    - Group cases in a run by signature, showing count and member cases.
    - Join against past runs to (a) reuse a human-assigned `defectType` as a suggestion (SAME / HIGH / LOW tiers) and (b) flag **New Error** signatures.
    - Sources: ReportPortal preprocessing, Unique Errors and ML Suggestions tiers ([Docs](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/UniqueErrorAnalysis.mdx), [Docs](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/MLSuggestions.md)).
16. **Known-pattern rules before the LLM.**
    - A small table of regex/string rules (for example a 429, a cookie-consent overlay, a CAPTCHA) applied **before** any model diagnosis, labelling the failure with a pattern name. `classify.ts` already does this for mechanical categories. Extend the same pre-LLM ordering to environment patterns.
    - Source: ReportPortal Pattern Analysis runs before Auto-Analysis ([Docs](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/PatternAnalysis.mdx)).
17. **Human label always wins; learn from it.**
    - Persist reviewer-assigned defect types. Never overwrite them with a model or heuristic. Use them as the labelled base for item 15.
    - Sources: mabl manual precedence ([Docs](https://help.mabl.com/hc/en-us/articles/50902973104916-2026-07-10-Automatic-failure-categorization)); BrowserStack's analysis requires prior manual tags ([Docs](https://www.browserstack.com/docs/test-reporting-and-analytics/features/auto-failure-analysis)).
18. **Flaky, New Failure and Always Failing smart tags from history.**
    - Key on a stable case signature (target origin + normalized case title/steps hash).
    - **flaky**: passed on a Playwright retry in the same run, or status flips >50% over the last 10 runs.
    - **new_failure**: a new error signature for the first time in the last 5 runs.
    - **always_failing**: the same signature across the last 5 runs.
    - Expose N and thresholds as env vars.
    - Sources: BrowserStack default rules ([Docs](https://www.browserstack.com/docs/test-reporting-and-analytics/features/smart-tags)); Katalon's pass→fail-transition PFS ([Docs](https://docs.katalon.com/katalon-platform/analytics/test-results-failures/investigate-flaky-tests)); Playwright flaky status ([Docs](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/test-retries-js.md)).
19. **Analyze the furthest-progressing attempt.**
    - When a case was retried or healed, feed the attempt that got furthest (most passed steps before the first failure) to the classifier and the LLM diagnosis, not just the last one.
    - Source: ReportPortal "defect assignment based on the longest retry" ([Docs](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/AutoAnalysisOfLaunches.mdx)).
20. **Look back for the root cause, and diff against the last passing run.**
    - On failure, compare the failing step's target element (attributes, text, bounding box, tag) and the preceding steps' after-states with the same steps in the last passing run of that case. Report the first step where they diverge as the likely root cause.
    - Sources: Functionize "root cause may have occurred several steps earlier" and Anomalous Attribute Tags ([Vendor](https://www.functionize.com/blog/functionize-root-cause-analysis-self-heal), [Docs](https://support.functionize.com/hc/en-us/articles/33000419162263-Debugging-Failed-Tests)); Applitools RCA change types ([Docs](https://applitools.com/docs/eyes/concepts/reviewing-tests/root-cause-analysis)); Perfecto's same-steps precondition ([Docs](https://help.perfecto.io/perfecto-help/content/perfecto/test-analysis/str-identify-test-failure-cause.htm)).

**Reporting**

21. **Attach a Playwright trace to every failed case.**
    - Set `trace: 'retain-on-failure'` (and `screenshot: 'only-on-failure'` if step screenshots aren't already taken). Link `trace.zip` from the HTML report, viewable with `npx playwright show-trace` or trace.playwright.dev.
    - This gives Before/Action/After DOM snapshots, network and console logs per action.
    - **Caveat:** traces contain network bodies and DOM. They must pass through `scrubServedSecrets` before being served (CLAUDE.md rule 5 / TD-14).
    - Source: Playwright trace docs ([Docs](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/trace-viewer.md)).
22. **Failure card layout.**
    - Per failed case show:
      - a **headline + summary + defectType + mechanical category**
      - **expected vs. actual** for the failing step
      - the before/after screenshots
      - the last-passing-run screenshot of the same step, side by side
      - smart-tag badges (flaky / new / always failing)
    - Sources: mabl `failure_analysis` shape ([Docs](https://help.mabl.com/hc/en-us/articles/38327846952212)); Functionize expected-vs-actual ([Docs](https://support.functionize.com/hc/en-us/articles/33000500963735-Using-Diagnose-Agent)); Testim and Perfecto side-by-side (see §3).
23. **Run-level "Unique errors" section and a new-errors gate.**
    - The report's summary groups failures by signature (item 15), sorted by matched-case count.
    - An optional CLI or CI flag fails the run on any **new** error signature or any flaky case.
    - Sources: ReportPortal Unique Errors and "New Errors" quality gate ([Docs](https://raw.githubusercontent.com/reportportal/docs/develop/docs/analysis/UniqueErrorAnalysis.mdx)); Playwright/Currents `failOnFlakyTests` ([Docs](https://docs.currents.dev/tests/flaky-tests)).
24. **Per-step timing anomaly (low priority).**
    - Record step and page-load durations per case signature. Flag a run that is significantly slower than the historical prediction as a warning.
    - Source: mabl "Page load time high" insight ([Docs](https://help.mabl.com/docs/insight-types)).
