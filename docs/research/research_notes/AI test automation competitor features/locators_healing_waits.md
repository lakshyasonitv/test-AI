# Element identification, self-healing and synchronisation in commercial and open-source test tools (as of Oct 2026)

**How this was researched, and how far to trust each line.** Several hosts would not resolve from this environment: arxiv.org, playwright.dev, help.mabl.com, docs.katalon.com, help.testim.io, docs.tricentis.com, support.functionize.com, the University of Genoa SEPL site, ACM DL, Wiley and dblp. GitHub, raw.githubusercontent.com and Maven Central did work. As a result:
- **Playwright, Testing Library and Cypress** claims come from their documentation source files on GitHub. That is the same text playwright.dev and the other sites publish.
- **Healenium, Similo/VON Similo/SimiloLLM and ROBULA+** claims come from source code I downloaded and read directly. The ROBULA+ code is a third-party implementation.
- **Testim, mabl, Katalon and Functionize** claims come from WebSearch result summaries of their official pages. I could not open those pages myself. Every such line is tagged `[via search summary]`.
- Partway through, the session's shared WebSearch budget ran out, so I could not do the planned searches on Virtuoso, spinner detection, or further LLM-repair papers. Those are listed under Gaps.

Source-type tags used throughout: **[OFFICIAL DOCS]**, **[SOURCE CODE]**, **[PEER-REVIEWED]**, **[PREPRINT]** (arXiv; venue not checked here), **[VENDOR MARKETING]**, **[THIRD-PARTY]**, **[COMMUNITY FORUM]**, **[OWN COMPUTATION]** (I ran it here, on code copied from the cited source).

---

## 1. Multi-attribute fingerprints: what is captured, how candidates are scored, thresholds, weight adaptation

### Takeaway
Only two systems publish exact attributes and weights: **Similo**, with 14 properties weighted 1.5 or 0.5, and **Healenium**, which combines a root-to-target path LCS with a per-node heuristic on a 350-point scale. Testim, mabl, Katalon and Functionize all say they keep a multi-attribute fingerprint and score candidates by confidence, but none publishes weights or thresholds. The one documented adaptation mechanism is Testim's per-run "auto-improve" against a confidence threshold. On the research side, Sidereal learns attribute fragility from earlier app versions.

### Cited Findings
**Similo (academic; weights read from the authors' own code)**
- Similo compares a stored target against every candidate using 14 properties. Each property has a comparison operator and a weight. The score is the sum of weight × comparator result over all 14 properties, and the highest-scoring candidate is returned — [arXiv 2208.00677 "Similarity-based web element localization for robust test automation"](https://arxiv.org/pdf/2208.00677) [PREPRINT, via search summary]
- The exact property list and weights, verbatim from the authors' code: `LOCATORS = { "tag", "class", "name", "id", "href", "alt", "xpath", "idxpath", "is_button", "location", "area", "shape", "visible_text", "neighbor_text" }` and `WEIGHTS = { 1.5, 0.5, 1.5, 1.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1.5, 1.5 }`. So **tag, name, id, visible_text and neighbor_text get 1.5**, and everything else gets 0.5 — [michelnass/SimiloLLM `Similo.java` L39–40](https://github.com/michelnass/SimiloLLM/blob/main/similollm/Similo.java) [SOURCE CODE]. A search summary agrees that Similo uses weights of 1.5 and 0.5, chosen by stability and uniqueness — [arXiv 2409.00411 / 2208.00677 search result](https://arxiv.org/pdf/2208.00677) [via search summary]
- Comparator per property, from `SIMILARITY_FUNCTION = {0,1,0,0,1,1,1,1,0,3,2,2,1,4}` in the same file [SOURCE CODE]:
  - **Case-insensitive equality** (scores 0 or 1): tag, name, id, is_button.
  - **Normalised Levenshtein**, `(len_longer − distance)/len_longer`, taking the best match across multi-values: class, href, alt, xpath, idxpath, visible_text.
  - **location**: `max(200 − euclideanPixelDistance, 0)/200`, so similarity falls linearly to 0 at 200 px.
  - **area and shape**: integer ratio `(max − |a−b|)/max`.
  - **neighbor_text**: character-weighted word overlap.
  - **Bonus:** an exact visible_text match doubles that weight (`if("visible_text".equals(locator) && similarity == 1) weight*=2;`).
  - A missing value on either side contributes 0. It is not a penalty.
- A later study found that Similo's 14 attributes are the most frequently populated ones on modern pages, and that **`id` is seldom used in practice**, so relying on it hurts localisation — [arXiv 2505.16424 "Web Element Relocalization in Evolving Web Applications: A Comparative Analysis and Extension Study"](https://arxiv.org/pdf/2505.16424) [PREPRINT, via search summary]
- **Similo++** (2025) adds two properties. `type` has 12% frequency and 96% stability; `aria-label` has 16% frequency and 82% stability. It also switches to Jaro-Winkler and set-similarity comparators — [arXiv 2505.16424](https://arxiv.org/pdf/2505.16424) [PREPRINT, via search summary]. The new weights were not in the summary.

**Healenium (open source; exact constants read from the `tree-comparing` 0.4.14 sources jar)**
- `healenium-web` declares `com.epam.healenium:tree-comparing:0.4.14` as its only Healenium library dependency — [healenium-web pom.xml](https://github.com/healenium/healenium-web/blob/master/pom.xml) [SOURCE CODE]
- Healenium scores a candidate node in two stages — [tree-comparing-0.4.14-sources.jar: `PathFinder.java`, `LCSPathDistance.java`](https://repo1.maven.org/maven2/com/epam/healenium/tree-comparing/0.4.14/tree-comparing-0.4.14-sources.jar) [SOURCE CODE]:
  1. **Path stage.** For every root-to-leaf path in the new DOM, compute the longest common subsequence against the stored root-to-target path. Two nodes are "equal" only when **tag and id are both equal** (`Node.equals` compares `tag` and `id`). Paths with LCS < 1 are dropped. For each remaining path, every node from position (LCS−1) to the leaf becomes a candidate.
  2. **Node stage.** Score each candidate with `HeuristicNodeDistance`, group the candidates by score, sort descending, keep those with score ≥ `score-cap`, then apply a limit.
- `HeuristicNodeDistance` constants, verbatim: `POINTS_FOR_TAG = 100.0; POINTS_FOR_LCS = 100.0; POINTS_FOR_ID = 50.0; POINTS_FOR_CLASS = 40.0; POINTS_FOR_VALUE = 30.0; POINTS_FOR_INDEX = 0; POINTS_FOR_OTHER_ATTRIBUTE = 30.0`. The final score is divided by their sum, **350** — [same jar, `HeuristicNodeDistance.java`](https://repo1.maven.org/maven2/com/epam/healenium/tree-comparing/0.4.14/tree-comparing-0.4.14-sources.jar) [SOURCE CODE]. How the score is built:
  - **Hard reject:** the score is 0 if path height is 0, or if path height > 5 and LCS/height < 0.7.
  - **Path:** + (LCS/height) × 100.
  - **Tag:** +100 for a case-insensitive tag match.
  - **id:** + 50 × Levenshtein similarity, **only when both nodes have an id**. Any distance over 30% of the length scores 0.
  - **innerText:** + 30 × Levenshtein similarity, with the same 30% cut-off.
  - **Classes:** + 40 × Jaccard similarity, or a full 40 when neither node has classes, plus a fuzzy Levenshtein term over the differing classes.
  - **Other attributes:** + 30 × the mean Levenshtein similarity across the union of attribute names (75% cut-off), or a full 30 when neither node has other attributes.
  - **Booleans** ("true"/"false") must match exactly.
- What a Healenium `Node` stores: `tag, id, classes, index, otherAttributes, innerText, parent, children` — [same jar, `Node.java`](https://repo1.maven.org/maven2/com/epam/healenium/tree-comparing/0.4.14/tree-comparing-0.4.14-sources.jar) [SOURCE CODE]

**Playwright codegen (the scoring used when generating locators, not when healing)**
- Lower scores are better. Verbatim constants: `kTestIdScore = 1`, `kOtherTestIdScore = 2` (data-testid / data-test-id / data-test when they are not the configured attribute), `kIframeByAttributeScore = 10`, `kRoleWithNameScore = 100`, `kPlaceholderScore = 120`, `kLabelScore = 140`, `kAltTextScore = 160`, `kTextScore = 180`, `kTitleScore = 200`, `kTextScoreRegex = 250`, `kCSSIdScore = 500`, `kRoleWithoutNameScore = 510`, `kCSSInputTypeNameScore = 520`, `kCSSTagNameScore = 530`, `kNthScore = 10000`, `kCSSFallbackScore = 10000000`. An exact-match variant adds `kExactPenalty = 5` — [microsoft/playwright `packages/injected/src/selectorGenerator.ts`](https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts) [SOURCE CODE]
- How the generator combines and limits candidates — [same file](https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts) [SOURCE CODE]:
  - Tokens in a chain are weighted by position, `score * (tokens.length - i)`, so earlier tokens count more.
  - Nesting is limited to two levels ("parent >>> target").
  - A parent selector may not use text when the target selector does.
  - Each candidate must match the target. A unique match stops the search ("Perfect strict match").
  - Otherwise it appends `nth=`, but only when index ≤ 5 ("Do not generate locators with nth=6 or worse").
  - Text over 80 characters is trimmed at a word boundary, and leading or trailing numbers are stripped (+2 bonus).
  - Unicode Private-Use characters (icon fonts) are excluded from text.
  - `penalizeScoreForLength` adds `min(10, floor(len/10))` to scores between 50 and 300.
- **Id handling:** an `id` becomes a candidate (score 500) only if `!isGuidLike(id)`. `isGuidLike` counts transitions between lower-case letters, upper-case letters, digits and other characters, ignoring `-` and `_`, and calls the id GUID-like when transitions ≥ length/4 — [same file L216, L462](https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts) [SOURCE CODE]
- **Running that function on real-world dynamic ids:**
  - Classified as **NOT** GUID-like, so still offered as `#id` candidates: `input-145`, `combobox-input-312`, `label-12`, `ember123`, `j_idt42`, `mui-7`, `react-select-3-input`, `gwt-uid-17`.
  - Classified as GUID-like: `:r1:`, `a1b2c3d4`, a UUID, and the Salesforce record id `01pXX0000004CzQ`.
  - [OWN COMPUTATION, on the function copied verbatim from Playwright's selectorGenerator.ts](https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts)

**Testim (Tricentis)**
- Testim's help says the Smart Locator algorithm "analyzes potentially hundreds of attributes associated with the element" and then "assigns weights to the attributes to uniquely identify the element" — [help.testim.io: Editing Target Element Properties](https://help.testim.io/docs/editing-target-element-properties) [OFFICIAL DOCS, via search summary]
- Testim's blog says the algorithm assigns confidence levels per attribute, and that a text attribute can rank above a style attribute because it is more unique. Its docs say the extension scans the DOM and scores each element's attributes — [testim.io blog](https://www.testim.io/?p=7714); [Tricentis: Why do you need Testim extension](https://docs.tricentis.com/testim/content/recording-tests/how-to-record-a-test/why-do-you-need-testim-extension.htm) [VENDOR MARKETING + OFFICIAL DOCS, via search summary]
- **Weight adaptation ("auto-improve"):** "on each test execution, our algorithm compares the locator's accuracy against the expected values". Locators auto-improve when they fall below a confidence threshold, and old and new locators are compared before the test is updated — [Testim: Announcing Auto-Improving Smart Locators](https://testim.io/?p=6611) [VENDOR MARKETING]; [Testim changelog: Locator auto-improve](https://help.testim.io/changelog/locator-auto-improve) [OFFICIAL DOCS] (both via search summary)
- Testim's mobile docs mention a user-adjustable threshold for its "Machine learning mode and Vision Locate" — [help.testim.io: Editing Target Element Properties (Mobile)](https://help.testim.io/docs/editing-target-element-properties-copy) [OFFICIAL DOCS, via search summary]
- I found no public numeric weights or threshold for Testim. A 2024 systematic review gives a worked example from an unnamed AI tool: each candidate gets a weight (the attribute's importance) and a stability score (consistency across past runs), and the tool picks the highest confidence, e.g. weight 0.98 × stability 1.0 → 98%. The paper does not say the tool is Testim — [arXiv 2409.00411 "AI-powered software testing tools: A systematic review…"](https://arxiv.org/pdf/2409.00411) [PREPRINT, via search summary]

**mabl**
- mabl collects element attributes when a step is recorded. This "element history" can include **ancestor elements and custom test-ID attributes**, and mabl uses it to track changes over time. Candidate search checks the recorded ancestor first, then the best-matching target inside it — [mabl: How auto-heal works](https://help.mabl.com/docs/how-auto-heal-works) [OFFICIAL DOCS, via search summary]
- "Configure Find" lets a user pick which attributes matter. When nothing matches all the selected attributes and auto-heal is on, mabl widens the search to the next best candidate; otherwise the step fails — [mabl: Configuring find steps](https://help.mabl.com/docs/configuring-find-steps); [changelog](https://help.mabl.com/changelog/configure-how-mabl-finds-elements) [OFFICIAL DOCS, via search summary]
- Element history is tracked **per environment** and can be rolled back to an earlier version — [mabl: How auto-heal works](https://help.mabl.com/docs/how-auto-heal-works) [OFFICIAL DOCS, via search summary]

**Functionize**
- Functionize's support docs say it captures **"thousands of data points per element"** rather than a single XPath or CSS selector, and that its ML engine fingerprints every element — [Functionize: Debugging Failed Tests](https://support.functionize.com/hc/en-us/articles/33000419162263-Debugging-Failed-Tests); [Functionize: Dynamic Learning / self-healing](https://www.functionize.com/self-healing) [OFFICIAL DOCS + VENDOR MARKETING, via search summary]. This conflicts with the brief's "hundreds of attributes"; the vendor's own wording is "thousands of data points".
- Functionize's FAQ lists its ML techniques as "K-means, Expectation Maximization, Recurrent Neural Networks (RNN), Convolutional Neural Networks (CNN), among others". It does not say which one drives fingerprinting — [Functionize FAQ](https://support.functionize.com/hc/en-us/articles/33002707491607-Frequently-Asked-Questions) [OFFICIAL DOCS, via search summary]
- A "99.97% element recognition accuracy" figure appears only on aggregator sites and is an unverified vendor claim — [stork.ai](https://www.stork.ai/en/functionize); [everydev.ai](https://www.everydev.ai/tools/functionize) [THIRD-PARTY, via search summary]

**Katalon**
- Self-healing tries alternative locator methods **in a user-ordered priority list**, and the docs advise moving the most stable or unique locators to the top. XPath variants have their own drag-to-reorder list, and the first XPath is the default — [Katalon: Self-healing tests in Katalon Studio](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio); [Katalon: Selection methods for Web objects](https://docs.katalon.com/katalon-studio/test-objects/web-test-objects/selection-methods-for-web-objects) [OFFICIAL DOCS, via search summary]
- Third-party guides give the default order as **XPath → attributes → CSS → image**. Katalon *Recorder*, a separate extension, documents **id → css → xpath** — [NashTech blog](https://blog.nashtechglobal.com/how-to-heal-the-locators-with-self-healing-mechanism-in-katalon-studio/) [THIRD-PARTY]; [Katalon Recorder self-healing](https://docs.katalon.com/katalon-platform/plugins-and-add-ons/katalon-recorder-extension/get-your-job-done/execute-scenarios/use-the-self-healing-function-in-katalon-recorder) [OFFICIAL DOCS] (both via search summary)
- From version 7.6.0, "Self-healing" replaced "Auto-healing Smart XPath". There is also an AI self-healing fallback for when classic healing fails — [Katalon: Auto-healing Smart XPath](https://docs.katalon.com/katalon-studio/maintain-tests/auto-healing-smart-xpath-in-katalon-studio) [OFFICIAL DOCS, via search summary]

**ROBULA+ / Sidereal (robust generation rather than healing)**
- Sidereal (Leotta, Ricca, Tonella, 2021) learns how fragile each HTML property was in **previous versions** of the app under test. It reports 55% fewer broken locators than ROBULA+ and 70% fewer than Montoto — [SEPL ROBULA page / unige IRIS](https://sepl.dibris.unige.it/ROBULA.php) [PEER-REVIEWED, via search summary]

### Inferences
- **Salesforce `input-145`, under Similo:** the id is an equality comparator with weight 1.5, so a regenerated id simply contributes 0 and the other 12.5+ points decide. A volatile id does not actively mislead Similo, as long as two different elements never share the same volatile id across sessions.
- **The same id under Healenium is worse in two ways:**
  - **Path stage:** LCS node equality requires the same tag *and* the same id. Churning ids on the target and its ancestors therefore shorten the LCS, and on deep Lightning trees (height > 5) the LCS/height < 0.7 rule can zero out the correct element.
  - **Node stage:** id similarity is fuzzy Levenshtein. `input-145` vs `input-146` scores (9−1)/9 ≈ 0.89 × 50 points, which actively *rewards* a neighbouring auto-generated field. That is a false-heal path.
- **Healenium's ceiling for id-less elements:** an element with no id can never earn the 50 id points, so its maximum normalised score is 300/350 ≈ 0.857. A `score-cap` near 0.86 would make id-less elements unhealable.
- **Playwright's `isGuidLike` does not catch framework counter ids** (`input-145`, `ember123`, `j_idt42`, `mui-7`). Codegen still avoids them in practice only because role+name (100) and label (140) outrank CSS id (500). A pipeline whose ladder puts `#id` above aria-label/role, as ours does, gets no such protection.
- **Two attributes recur across every source** that publishes or describes its attributes (Similo, Healenium, mabl, Testim): **visible/inner text** and **ancestor/neighbour context**. Similo gives both its top weight.

### Gaps
- Testim, mabl, Katalon and Functionize publish no numeric weights, attribute lists or thresholds. I found none in their docs or in search.
- Similo++ weights for `type` and `aria-label` were not in the search summary, and arxiv.org would not resolve to check.
- **Virtuoso:** nothing found. The search budget ran out before I reached it, and I could not identify its docs domain without search.

---

## 2. Self-healing workflows: runtime vs post-run, human approval, auto-update, false-heal guards, auditing

### Takeaway
Every commercial tool heals **at runtime** so the run continues, then splits on persistence. Katalon heals temporarily and needs explicit approval. Testim auto-improves unless a person has customised the locator. mabl updates element history per environment with rollback. Functionize flags heals with tags and offers one-click "SmartFix". Healenium logs heals to a database and a person applies them to code through an IDE plugin. The documented false-heal guards are: a score floor, uniqueness of the healed locator, never healing user-authored CSS/XPath or customised locators, never healing absence checks, and failing when confidence is low.

### Cited Findings
- **Katalon:** healed objects appear in a **Self-healing Insights** tab with the broken object's ID, the default locator that failed, the proposed locator, the selection method used, and a **screenshot** of the healed object. "The updated locator for the test run is saved temporarily, and you need to approve this change to make it permanent" — [Katalon: Self-healing tests in Katalon Studio](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio) [OFFICIAL DOCS, via search summary]; same workflow described by [NashTech](https://blog.nashtechglobal.com/self-healing-using-katalon/) [THIRD-PARTY]
- Katalon supports **excluding objects or keywords from self-healing** — [Perficient: Understanding self-healing object exclusion in Katalon Studio](https://blogs.perficient.com/2024/03/18/understanding-self-healing-object-exclusion-in-katalon-studio) [THIRD-PARTY, via search summary]
- A Katalon forum thread titled "Katalon self-healing is picking the wrong element" exists. I saw only its title, but it is evidence that false heals happen in practice — [forum.katalon.com](https://forum.katalon.com/t/katalon-self-healing-is-picking-the-wrong-element/191950) [COMMUNITY FORUM]
- **mabl:**
  - **Order:** strong match first, then standard auto-heal (partial match against the element model), then **advanced GenAI auto-heal only if standard fails**. "When confidence is low, mabl fails the step."
  - **No heal for hand-written locators:** steps using custom CSS or XPath **do not auto-heal**, because they say exactly how to find the element.
  - **Rollback limit:** rolling back element history does **not** stop the same auto-heal from recurring. mabl recommends Configure Find or visual click for a durable fix.
  - Source: [mabl: How auto-heal works](https://help.mabl.com/docs/how-auto-heal-works) [OFFICIAL DOCS, via search summary]
- **Testim:**
  - **No override of user edits:** "if you have customized your locator, we assume that you did that for a reason and we won't attempt to improve it."
  - **Validate before swap:** replacement locators are swapped in only after validation passes.
  - **Two manual repair actions:** "Reassign" means picking a new element. "Improve" compares the existing locators with newly collected ones and **updates (instead of override)**.
  - Sources: [Testim blog](https://testim.io/?p=6611) [VENDOR MARKETING]; [help.testim.io: Editing Target Element Properties](https://help.testim.io/docs/editing-target-element-properties) [OFFICIAL DOCS] (via search summary)
- Testim surfaces warnings on test steps in its UI — [Testim changelog: view warnings in test steps](https://help.testim.io/changelog/view-warnings-in-test-steps) [OFFICIAL DOCS, title via search result only]
- **Functionize:** "At execution time, Functionize automatically attempts to self-heal failed selectors using our ML models". Self-heals are **marked with yellow tags** in Test Details and Slider View. A separate **SmartFix** feature suggests one-click fixes for incorrect element selections, incorrect verifications and incorrect passwords — [Functionize: Debugging Failed Tests](https://support.functionize.com/hc/en-us/articles/33000419162263-Debugging-Failed-Tests) [OFFICIAL DOCS, via search summary]
- **Healenium, runtime:**
  - **Settings:** `heal-enabled` turns healing on or off, also via `-Dheal-enabled=false`. `score-cap = 0.5` means "healing happens when the match probability is at least 50%". `recovery-tries = 1`.
  - **Absence checks:** the `@DisableHealing` annotation exists for checks such as asserting that an element is absent.
  - **Applying heals:** the **hlm-idea** IntelliJ plugin updates locators in test code.
  - Source: [healenium-web README](https://github.com/healenium/healenium-web) [OFFICIAL DOCS]
- **Healenium, acceptance rule in code:** a newly generated locator is used only if `elements.size() == 1` **and** the element is not already in `context.getElementIds()`. Candidate locators are tried from coarse to detailed: `TAG+ID` … `PATH`, or an XPath built by the selector-imitator service. At most 10 candidates are logged — [healenium-web `HealingService.java`](https://github.com/healenium/healenium-web/blob/master/src/main/java/com/epam/healenium/service/HealingService.java) [SOURCE CODE]
- **Healenium, storage:** a PostgreSQL database stores "reference selectors / healing / report". `hlm-backend` is the CRUD service, and the selector imitator "convert[s] healed locator to convenient format" — [healenium/healenium README](https://github.com/healenium/healenium) [OFFICIAL DOCS]
- **Playwright Test Agents (1.56):**
  - **What the healer does:** it "replays the failing steps", inspects the current UI for equivalent elements or flows, and "suggests a patch (e.g., locator update, wait adjustment, data fix)".
  - **When it stops:** it "re-runs the test until it passes or until guardrails stop the loop".
  - **What it outputs:** "A passing test, or a skipped test if the healer believes that functionality is broken".
  - **Contradiction:** the page also says the healer "automatically repairs failing tests". It is unclear whether patches are applied without review.
  - Source: [microsoft/playwright `docs/src/test-agents-js.md`](https://github.com/microsoft/playwright/blob/main/docs/src/test-agents-js.md) [OFFICIAL DOCS]

### Inferences
- The industry splits **"heal for this run"** from **"persist the heal"**. Only Katalon (explicit approval) and Healenium (a developer applies it in the IDE) make persistence a person's decision by default. Testim and mabl persist automatically, with opt-outs and rollback.
- The most transferable false-heal guards found:
  1. A **score floor**: Healenium's `score-cap`, and mabl's fail-on-low-confidence.
  2. The **healed locator must be unique** and **must not resolve to an element already bound to another step**. This is Healenium's `context.getElementIds()` check, and it blocks "two steps healed onto the same box".
  3. **Never heal explicit locators** written by a person (mabl, Testim).
  4. **Never heal negative/absence assertions** (Healenium `@DisableHealing`).
  5. **Fail rather than heal when the app is functionally broken** (Playwright healer's skip outcome).
- mabl's note that **rollback does not prevent the heal from recurring** shows that "reject a heal" needs to be stored as a negative example, not just as a revert.

### Gaps
- No vendor documents a quantitative false-heal rate.
- I found no published wording on mabl or Testim heal-review UIs beyond the items above. Virtuoso's workflow was not researched (search budget).

---

## 3. Algorithms and reported accuracy: Healenium, Similo, VON Similo, ROBULA+

### Takeaway
- **Similo** (multi-attribute weighted similarity) located **710 of 801** target elements correctly across 48 apps in its replication data. The best baseline (multi-locator) located 587, and ROBULA+ located 490.
- **VON Similo** merges the attributes of elements that visually overlap (IoU ≥ 0.85 or containment) and raised accuracy from 0.783 to 0.879 on its benchmark.
- **ROBULA+** generates XPaths by top-down refinement from `//*` and cut locator fragility by about 90% vs absolute XPaths.
- **Healenium** is LCS over root-to-target paths plus a 350-point node heuristic, cut at `score-cap`.
- The crucial difference is how each fails. Single locators fail *loudly* (not found). Similo **never** fails loudly: all of its errors are silent wrong-element picks.

### Cited Findings
- **Similo replication results** (48 apps, 801 targets; per-approach totals summed from the authors' results table) — [michelnass/Similo2 `WidgetLocator/FinalResultsTable.txt`](https://github.com/michelnass/Similo2/blob/main/WidgetLocator/FinalResultsTable.txt) [SOURCE CODE / replication data; OWN COMPUTATION of totals]:

  | Approach | Column 1 | Column 2 | Column 3 |
  |---|---|---|---|
  | Similo | 710 | 0 | 91 |
  | Multilocator | 587 | 214 | 0 |
  | ROBULA | 490 | 279 | 32 |
  | Montoto | 422 | 368 | 11 |
  | Selenium IDE | 394 | 362 | 45 |
  | idxpath | 326 | 426 | 49 |
  | absolute xpath | 136 | 637 | 28 |

  The replication readme confirms 48 apps (`"Set the application number between 0 and 47 (48 apps)"`) — [Similo2 readme.txt](https://github.com/michelnass/Similo2/blob/main/WidgetLocator/readme.txt) [SOURCE CODE]. The column meanings are my inference; see Inferences below.
- **VON Similo results:** across 33 web pages it reported mean precision 0.965 and accuracy 0.879, against Similo's 0.799 precision and 0.783 accuracy. The ROC curves show VON Similo better overall — [arXiv 2301.03863 "Robust web element identification for evolving applications by considering visual overlaps"](https://arxiv.org/pdf/2301.03863) [PREPRINT, via search summary]
- **VON Similo mechanism in code:** for each element, find every other element whose rectangle intersects it with `intersection_area / bounding_union_area >= 0.85`, **or** which it contains. Copy that element's "overlapping" properties onto it, appending multi-values joined with `" || "`. `IS_OVERPAPPING` marks every property except location, area, shape and neighbor_text as mergeable. Comparators then take the **max over all value pairs** — [SimiloLLM `Similo.java` `addOverlappingLocatorParameters`, L2247–2300](https://github.com/michelnass/SimiloLLM/blob/main/similollm/Similo.java) [SOURCE CODE]. A search summary of the LLM paper describes the same trade-off: a property holding more than one value is compared once per value — [arXiv 2310.02046](https://arxiv.org/pdf/2310.02046) [PREPRINT, via search summary]
- **The 2025 re-evaluation is mixed:**
  - On an extended benchmark, Similo beats VON Similo at identifying visual overlaps.
  - VON Similo remains best on the original LLM VON Similo benchmark.
  - "HybridSimilo" (VON Similo pre-selects candidates, Similo++ chooses) performs about the same as Similo++.
  - Source: [arXiv 2505.16424](https://arxiv.org/pdf/2505.16424) [PREPRINT, via search summary]
- **ROBULA+ authorship and results:** by Leotta, Stocco, Ricca and Tonella, *Journal of Software: Evolution and Process* (2016, DOI 10.1002/smr.1771). It reduced fragility "on average by 90% w.r.t. absolute locators and by 63% w.r.t. Selenium IDE locators". The earlier ROBULA (ISSREW 2014) "starts with a generic XPath locator that returns all nodes (`//*`), then iteratively refines the locator until only the element of interest is selected" — [SEPL ROBULA page](https://sepl.dibris.unige.it/ROBULA.php); [ROBULA+ preprint PDF](https://sepl.dibris.unige.it/publications/2016-leotta-JSEP.pdf); [unige IRIS record](https://iris.unige.it/handle/11567/859128) [PEER-REVIEWED, via search summary]
- **ROBULA+ algorithm details** (a third-party TypeScript implementation of the published algorithm):
  - Attribute priority list: `['name', 'class', 'title', 'alt', 'value']`.
  - Attribute blacklist: `['href', 'src', 'onclick', 'onload', 'tabindex', 'width', 'height', 'style', 'size', 'maxlength']`.
  - Transformations, applied in order to each queued XPath: `transfConvertStar` → `transfAddId` → `transfAddText` → `transfAddAttribute` → `transfAddAttributeSet` → `transfAddPosition` → `transfAddLevel`.
  - The first candidate that `uniquelyLocate`s the element is returned. `transfAddLevel` stops growing once the path length reaches the ancestor count.
  - Source: [cyluxx/robula-plus `src/index.ts`](https://github.com/cyluxx/robula-plus/blob/master/src/index.ts) [THIRD-PARTY SOURCE CODE]
- **Healenium's algorithm** is described in §1 from its source. The README does not name the algorithm; the top-level README only says it "leverages the power of machine learning" — [healenium/healenium](https://github.com/healenium/healenium) [OFFICIAL DOCS]. Its own `LCSPathDistance` Javadoc reads "Metric based on Longest common subsequence" — [tree-comparing jar](https://repo1.maven.org/maven2/com/epam/healenium/tree-comparing/0.4.14/tree-comparing-0.4.14-sources.jar) [SOURCE CODE]

### Inferences
- **Reading the Similo table:** I read the three columns as *correct / not found / wrong element*. Evidence: column 2 is 0 for Similo, which by construction always returns a top candidate, and column 3 is 0 for Multilocator. On that reading:
  - Similo got 88.6% correct, and **all 91 of its errors (11.4%) were silent wrong-element hits**.
  - Multilocator got 73.3% correct with **zero** wrong hits.
  - That is the core healing trade-off in numbers: scoring wins on recall but needs a separate guard against false heals.
- **Healenium has no published benchmark** comparable to Similo's. Its design (path LCS plus local node similarity) is close to Similo's "xpath + attributes" subset, but it has **no visual (location/area/shape) or neighbour-text signal**. Those two are the signals VON Similo found most helpful when the DOM is restructured.
- **ROBULA+ prefers `@id` early** (`transfAddId` runs second). On Salesforce-style counter ids it would produce `//*[@id='input-145']`, which breaks on the next session, unless volatile ids are blacklisted first.

### Gaps
- Exact Similo paper venue and numbers (the TOSEM version) could not be checked: arxiv and ACM DL were unreachable.
- The VON Similo numbers come from a search summary, not the PDF.
- No independent benchmark of Healenium accuracy was found.

---

## 4. LLM-based locator repair research (2023–2026)

### Takeaway
The best-documented academic pattern is **"deterministic scorer shortlists, LLM picks"**. VON Similo LLM ranks candidates with VON Similo, then asks GPT-4 to choose among the **top 10**, answering only with an id. Industry has converged on the same layering: mabl (GenAI only after standard heal fails), Katalon (AI fallback after classic healing), Playwright 1.56's healer agent (proposes patches, can skip a test as "functionality broken"). I could not retrieve further 2024–2026 LLM-repair papers because the search budget ran out.

### Cited Findings
- **VON Similo LLM, as implemented in the authors' code** — [michelnass/SimiloLLM `SimiloLLMTest.java`, `Conversation.java`](https://github.com/michelnass/SimiloLLM/blob/main/similollm/SimiloLLMTest.java) [SOURCE CODE]:
  - The model is `gpt-4`, called through the OpenAI chat-completions API.
  - Candidates are ranked by VON Similo.
  - An **outlier threshold** is computed as `Q3 + 1.5 × IQR` over the top-10 candidate scores (`higherOutlier`).
  - The top-10 candidates are serialised as compact JSON, with multi-values joined by `||`, and the model is prompted: *"Given the following candidate web elements (|| means that an attribute can have multiple values): … find the one that is most similar to the element: … Answer with the widget_id number(digits) only, no explanation or text characters."*
  - There are zero-shot and one-shot variants. A variant system prompt says "There are no specific weightings for the provided attributes", and another asks the model to "motivate why (using a list)".
  - The experiment logs separately the cases where the oracle was **not among the top-10 candidates** at all.
- The README describes the dataset as old and new element snapshots plus an oracle file, with results for ZeroShot, OneShot, VONSimilo and VONSimiloLLM — [SimiloLLM ReadMe](https://github.com/michelnass/SimiloLLM) [SOURCE CODE]
- The paper itself: "Improving web element localization by using a large language model" — [arXiv 2310.02046](https://arxiv.org/pdf/2310.02046) [PREPRINT, via search summary; numbers not retrieved]
- **The 2025 comparative study** extends this line with Similo++ and HybridSimilo and evaluates on both the "original LLM VON Similo benchmark" and an extended one — [arXiv 2505.16424](https://arxiv.org/pdf/2505.16424) [PREPRINT, via search summary]
- **mabl advanced auto-heal** uses generative AI "to favor meaningful attributes over random IDs" and can match semantically similar text (e.g. "Confirm" → "Approve"). It is tried only after standard strategies fail, and the step fails when confidence is low — [mabl: How auto-heal works](https://help.mabl.com/docs/how-auto-heal-works) [OFFICIAL DOCS, via search summary]
- **Katalon** offers "self-healing with AI, as a fallback when self-healing fails to detect a locator the classic way" — [Katalon: Self-healing tests](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio) [OFFICIAL DOCS, via search summary]
- **Playwright healer agent** (1.56): replay, inspect, patch (locator, wait or data), loop under guardrails, or mark the test skipped — [playwright `test-agents-js.md`](https://github.com/microsoft/playwright/blob/main/docs/src/test-agents-js.md) [OFFICIAL DOCS]
- **Healenium** now publishes `healenium-mcp` (no description) and Playwright proxy examples, including "Healenium Pro Playwright JS" — [github.com/orgs/healenium/repositories](https://github.com/orgs/healenium/repositories) [OFFICIAL, repo listing only]

### Inferences
- **Why VON Similo LLM is a good fit for us:** it cannot hallucinate a locator. The LLM only chooses a `widget_id` from a deterministic shortlist, and the shortlist's own recall (oracle in the top-10 or not) is measured separately. That is exactly this repo's "LLM proposes, code verifies" rule.
- **How the outlier test is meant to work:** if the best score is an IQR outlier, the deterministic answer is trusted. If it is not, the case is ambiguous, and that is where an LLM tie-break (or a human) adds value. This reading comes from the code's structure; the paper's stated policy was not retrieved.

### Gaps
- Not covered, because the search budget was exhausted:
  - other 2023–2026 LLM locator-repair papers, from ICST, ICSE, FSE, ASE, ISSTA or arXiv;
  - vision-LLM locator repair;
  - the reported accuracy deltas for VON Similo LLM.
- These need a follow-up search session.

---

## 5. Synchronisation: actionability, auto-waiting, Smart Wait, learned waits, network idle, SPAs

### Takeaway
Playwright's model is the reference. It waits **per action** for that action's actionability checks: visible, stable for 2 animation frames, receives events, enabled, editable, not inert. It retries web-first assertions, explicitly marks `networkidle` as **DISCOURAGED**, and warns that clicks during hydration can silently do nothing. Katalon's Smart Wait (waiting for AJAX and DOM quiet) is opaque and has documented slowdowns. mabl learns per-step timing from past runs. Cypress and Playwright both forbid fixed sleeps.

### Cited Findings
- **Playwright auto-waiting:** "It auto-waits for all the relevant checks to pass and only then performs the requested action". If checks do not pass within the timeout, the action fails with `TimeoutError` — [playwright `docs/src/actionability.md`](https://github.com/microsoft/playwright/blob/main/docs/src/actionability.md) [OFFICIAL DOCS]
- **Playwright check definitions**, verbatim from [actionability.md](https://github.com/microsoft/playwright/blob/main/docs/src/actionability.md) [OFFICIAL DOCS]:
  - **Visible:** "non-empty bounding box and does not have `visibility:hidden` computed style".
  - **Stable:** "maintained the same bounding box for at least two consecutive animation frames".
  - **Enabled:** "**not disabled**".
  - **Editable:** "[enabled] and is **not readonly**".
  - **Receives Events:** "the hit target of the pointer event at the action point".
- **Which checks each action runs** — [same page](https://github.com/microsoft/playwright/blob/main/docs/src/actionability.md) [OFFICIAL DOCS]:

  | Actions | Checks |
  |---|---|
  | click, dblclick, check, uncheck, setChecked, tap | visible, stable, receives events, enabled, not inert |
  | hover, dragTo | visible, stable, receives events |
  | fill, clear | visible, enabled, editable, not inert |
  | selectOption | visible, enabled |
  | screenshot | visible, stable |
  | selectText | visible |
  | scrollIntoViewIfNeeded | stable |
  | focus, press, pressSequentially, setInputFiles, blur, dispatchEvent | none |

  `force` "disables non-essential actionability checks".
- **`networkidle`:** "'networkidle' - **DISCOURAGED** consider operation to be finished when there are no network connections for at least `500` ms. Don't use this method for testing, rely on web assertions to assess readiness instead." `commit` means the response was received and the document started loading — [playwright `docs/src/api/params.md`](https://github.com/microsoft/playwright/blob/main/docs/src/api/params.md) [OFFICIAL DOCS]
- **Navigation and hydration:**
  - "In Playwright you can interact with the page at any moment. It will automatically wait for the target elements to become actionable".
  - For multiple navigations, wait explicitly with `page.waitForURL`.
  - A click on a page that is still hydrating can run with no effect: "the click won't have any effect".
  - `waitForLoadState`: "you should not need it in most cases".
  - Sources: [playwright `docs/src/navigations.md`](https://github.com/microsoft/playwright/blob/main/docs/src/navigations.md); [class-page.md](https://github.com/microsoft/playwright/blob/main/docs/src/api/class-page.md) [OFFICIAL DOCS]
- **Web-first assertions:** prefer `await expect(locator).toBeVisible()` over `expect(await locator.isVisible()).toBe(true)`, because the manual form "won't wait a single second" — [playwright `best-practices-js.md`](https://github.com/microsoft/playwright/blob/main/docs/src/best-practices-js.md) [OFFICIAL DOCS]
- **Katalon Smart Wait, officially:** it "automatically waits for all front-end processes of a page to complete before taking further test steps". It shipped in 7.0.0 as a browser extension and is on by default under Project > Settings > Execution > WebUI. Chrome support dates from 7.0.0; Edge Chromium and Firefox from 8.2.0 — [Katalon: Smart Wait function](https://docs.katalon.com/katalon-studio/record-and-spy/webui-record-and-spy-utilities/smart-wait-function) [OFFICIAL DOCS, via search summary]
- **Katalon Smart Wait internals, per forum analysis only:** injected JS that notifies on "all AJAX events and DOM Tree modification events", built on a `MutationObserver`. These are not confirmed by Katalon — [forum: Technical issue with Smart Wait in 8.0](https://forum.katalon.com/t/technical-issue-with-smart-wait-algorithm-in-katalon-studio-8-0/101518); [forum: SmartWait is not working any more](https://forum.katalon.com/t/smartwait-is-not-working-any-more/123253) [COMMUNITY FORUM]
- **Katalon Smart Wait pitfalls reported on the forum** [COMMUNITY FORUM]:
  - A continuously updating AJAX stream makes it repeatedly hit the **30 s default maximum**. A Chrome deprecation warning about synchronous `DOMNodeInserted` was also reported — [forum](https://forum.katalon.com/t/why-does-default-smart-wait-stops-working-all-of-the-sudden/87016).
  - After 10.3.1, one suite went from **3m 24s to 7m 30s**. The suggested workaround is disabling it by default and calling `WebUI.enableSmartWait()` / `WebUI.disableSmartWait()` where needed — [forum](https://forum.katalon.com/t/katalon-10-3-1-smart-wait-is-now-much-much-slower/180887).
- **mabl:** uses data from past runs "to decide when the element should appear and be actionable". The Configure Find timeout defaults to **15 s**, with a maximum of **15 min** — [mabl: How auto-heal works](https://help.mabl.com/docs/how-auto-heal-works); [mabl: Configuring find steps](https://help.mabl.com/docs/configuring-find-steps) [OFFICIAL DOCS, via search summary]
- **Cypress:** "you almost never need to use `cy.wait()` for an arbitrary amount of time". Instead, "Use route aliases or assertions to guard Cypress from proceeding until an explicit condition is met" — [cypress-documentation `best-practices.mdx`](https://github.com/cypress-io/cypress-documentation/blob/main/docs/app/core-concepts/best-practices.mdx) [OFFICIAL DOCS]
- **Timeout defaults:** actions default to 30 s in the Python, Java and C# bindings. In JS the API-level default is `0` (no timeout), with the test runner supplying its own — [playwright `params.md`](https://github.com/microsoft/playwright/blob/main/docs/src/api/params.md) [OFFICIAL DOCS]

### Inferences
- **"Wait for DOM/network quiet" is fragile on modern apps.** Playwright, the tool with the most transparent design, rejects it outright, and Katalon's forum documents the failure mode on live-polling apps (endless AJAX). The robust signals are per-action actionability, a URL assertion, and an app-specific "ready" assertion.
- **Salesforce Lightning is exactly the case these docs describe.** It is a hydrated SPA with continuous background XHR, so `networkidle` would be both slow and unreliable there. The hydration warning means "element visible and enabled" can still be true before handlers attach. A post-navigation readiness assertion on a known-interactive landmark is safer than a load state.
- **mabl's learned per-step timing** suggests storing the observed time-to-actionable for each step from passing runs, and flagging a step whose wait time drifts.

### Gaps
- **Spinner/overlay detection heuristics:** no source found. The search budget ran out before I reached this topic.
- mabl's exact wait algorithm is undocumented beyond "data from past runs".
- Katalon has not confirmed Smart Wait's internals.

---

## 6. Shadow DOM and iframes

### Takeaway
Playwright's CSS and role locators pierce **open** shadow roots. XPath does not, and closed roots are unsupported. iframes need `frameLocator`/`contentFrame`, and codegen scores an iframe by `name`/`title` at 10. Katalon's Smart Locator is marketed for shadow DOM, nested iframes, dynamic ids and SVG. I found no documentation on shadow DOM handling in mabl, Testim, Functionize or Healenium.

### Cited Findings
- "All locators in Playwright by default work with elements in Shadow DOM. Exceptions: Locating by XPath does not pierce shadow roots. Closed-mode shadow roots are not supported" — [playwright `docs/src/locators.md`](https://github.com/microsoft/playwright/blob/main/docs/src/locators.md) [OFFICIAL DOCS]
- Locator-creating methods are "also available on the [Locator] and [FrameLocator] classes", so a frame is entered with `page.frameLocator(...)` — [same](https://github.com/microsoft/playwright/blob/main/docs/src/locators.md) [OFFICIAL DOCS]
- Codegen identifies an `<iframe>` by `iframe[name=…]` or `iframe[title=…]` (score 10) or by test id, using CSS only, because "Everything below is not applicable to iframes (getBy* methods)" — [selectorGenerator.ts](https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts) [SOURCE CODE]
- Katalon: "Smart locators are particularly efficient in test scenarios that involve complex Shadow DOM structures, nested iframes, dynamic ID, or elements inside SVG". They are supported in Chrome, Firefox and Edge Chromium — [Katalon: Selection methods for Web objects](https://docs.katalon.com/katalon-studio/test-objects/web-test-objects/selection-methods-for-web-objects) [OFFICIAL DOCS, via search summary]
- Healenium rebuilds the page tree with **Jsoup**, an HTML parser (`JsoupHTMLParser`, imported by `SelfHealingEngine`) — [healenium-web `SelfHealingEngine.java`](https://github.com/healenium/healenium-web/blob/master/src/main/java/com/epam/healenium/SelfHealingEngine.java); [tree-comparing jar](https://repo1.maven.org/maven2/com/epam/healenium/tree-comparing/0.4.14/tree-comparing-0.4.14-sources.jar) [SOURCE CODE]
- **Our own schema** already records `frame` (an iframe CSS chain joined by `" >>> "`) and `inShadow` (open roots only) per element — [src/schema/appModel.ts](../../../../src/schema/appModel.ts) [THIS REPO]

### Inferences
- **Healenium is probably blind inside shadow roots.** Shadow DOM content is not part of serialised page HTML, so a Jsoup-parsed snapshot would not contain it. This is not verified: I did not read how `NodeService` builds the tree.
- **Any XPath-based fallback is unusable inside shadow DOM.** That includes ROBULA+ output and Similo's `xpath`/`idxpath` attributes. Both a generator and a healer must skip XPath candidates for `inShadow` elements.

### Gaps
- mabl, Testim, Functionize and Virtuoso shadow DOM and iframe behaviour: not found.
- Salesforce LWC/synthetic-shadow specifics: not researched here (search budget).

---

## 7. Locator selection guidance: Playwright priority, Testing Library, Cypress, codegen scoring

### Takeaway
Playwright and Testing Library put **role + accessible name** first and treat CSS/XPath as a last resort. They **disagree on test ids**. Testing Library puts them last ("the user cannot see these"). Cypress rates `data-cy` "Always / Best". Playwright's *codegen* scores a configured test id as the very best (1), ahead of role+name (100). Playwright's layout locators (`:below`, `:right-of`, `:near`) are **officially deprecated**.

### Cited Findings
- **Playwright's recommended built-in locators,** in documented order: `getByRole, getByText, getByLabel, getByPlaceholder, getByAltText, getByTitle, getByTestId`. "We recommend prioritizing user-facing attributes and explicit contracts" — [playwright `locators.md`](https://github.com/microsoft/playwright/blob/main/docs/src/locators.md) [OFFICIAL DOCS]
- **Strictness:** "Locators are strict". An operation throws if more than one element matches; `first`/`last`/`nth` are "not recommended". The test id attribute defaults to `data-testid` and is configurable through `use.testIdAttribute` or `selectors.setTestIdAttribute` — [same](https://github.com/microsoft/playwright/blob/main/docs/src/locators.md) [OFFICIAL DOCS]
- **Bad vs good example:** bad is `page.locator('button.buttonIcon.episode-actions-later')`; good is `page.getByRole('button', { name: 'submit' })`. "Your DOM can easily change so having your tests depend on your DOM structure can lead to failing tests" — [playwright `best-practices-js.md`](https://github.com/microsoft/playwright/blob/main/docs/src/best-practices-js.md) [OFFICIAL DOCS]
- **Codegen:** "Playwright will look at your page and figure out the best locator, prioritizing role, text and test id locators. If the generator finds multiple elements matching the locator, it will improve the locator to make it resilient" — [playwright `codegen.md`](https://github.com/microsoft/playwright/blob/main/docs/src/codegen.md) [OFFICIAL DOCS]. The internal scores are in §1.
- **Layout locators:** "Layout selectors are deprecated and may be removed in the future. Matching based on layout may produce unexpected results." `:near` means "within 50 CSS pixels". Matches are "sorted by their distance to the anchor element", and every layout pseudo-class accepts an optional maximum pixel distance — [playwright `other-locators.md`](https://github.com/microsoft/playwright/blob/main/docs/src/other-locators.md) [OFFICIAL DOCS]
- **Text pseudo-classes:**
  - `:has-text()` is "case-insensitive, trims whitespace and searches for a substring".
  - `:text()` "matches the smallest element containing specified text".
  - `:text-is()` is an exact, case-sensitive match.
  - Source: [same](https://github.com/microsoft/playwright/blob/main/docs/src/other-locators.md) [OFFICIAL DOCS]
- **Testing Library priority:** "your test should resemble how users interact with your code"; the queries are grouped in three tiers — [testing-library-docs `queries/about.mdx`](https://github.com/testing-library/testing-library-docs/blob/main/docs/queries/about.mdx) [OFFICIAL DOCS]:
  1. **Accessible to everyone:** `getByRole` ("top preference for just about everything"), then `getByLabelText`, `getByPlaceholderText` ("A placeholder is not a substitute for a label"), `getByText`, `getByDisplayValue`.
  2. **Semantic:** `getByAltText`, `getByTitle` ("not consistently read by screenreaders").
  3. **Test IDs:** `getByTestId`, "only recommended for cases where you can't match by role or text or it doesn't make sense (e.g. the text is dynamic)".
- **Cypress selector ratings:**
  - Never: `cy.get('button')` and `.btn.btn-large`.
  - Sparingly: `#main` and `[name=submission]`.
  - Depends: `cy.contains('Submit')`, and `cy.getByRole('button',{name:'Submit'})`, which "checks both the role and the accessible name, so it's coupled to each".
  - Always: `[data-cy="submit"]`, "Best. Isolated from all changes".
  - Rule of thumb: "If the content of the element changed would you want the test to fail?" Cypress "loves the Testing Library project", supports `findByRole` and `findByLabelText` through Cypress Testing Library, and has a built-in `cy.getByRole()`.
  - Source: [cypress-documentation `best-practices.mdx`](https://github.com/cypress-io/cypress-documentation/blob/main/docs/app/core-concepts/best-practices.mdx) [OFFICIAL DOCS]

### Inferences
- **Our ladder vs Playwright's scores.** Our discovery ladder is data-test/data-testid/data-qa > `#id` > name > aria-label > role[name] > label-anchored `:below`/`:right-of` > positional. Compared with Playwright's internal scores:
  1. **`#id` is too high:** Playwright ranks a CSS id (500) *below* role+name (100), label (140) and text (180).
  2. **The label-anchored step uses a deprecated feature:** Playwright's layout pseudo-classes are deprecated.
  3. **`data-qa` is not one of Playwright's built-in alternates.** Playwright only auto-recognises `data-testid`, `data-test-id` and `data-test` as "other test ids" (score 2). `data-qa` would need configuring via `testIdAttribute`, which accepts a list (`splitTestIdAttributeNames`).
- **The test-id disagreement is about what the test is checking.** Testing Library optimises for accessibility semantics; Cypress and Playwright codegen optimise for stability. For an AI pipeline that does not own the app under test, a real `data-testid` is the most stable signal when present. When absent, which is common, role+name is the next most stable and readable.

### Gaps
- None material. The primary docs were retrieved.

---

## 8. Adoptable techniques for our pipeline

### Takeaway
The sources support a concrete upgrade in seven parts. Each part below lists its sources inline:
1. A **Similo-style fingerprint** stored at discovery.
2. A **volatile-id detector**, stronger than Playwright's.
3. A **weighted similarity healer** with literature weights.
4. **Three false-heal gates**: a score floor, an outlier/margin test, and uniqueness plus not-already-bound.
5. **LLM tie-break only on ambiguous shortlists.**
6. **Run-scoped heals that need approval to persist.**
7. **Readiness checks built on actionability**, not network idle.

### Cited Findings (each technique paired with its source)
1. **Fingerprint fields to store per element at discovery.** These would be additive optional fields on `Element`, written by the live walker and behind a flag, per this repo's rules.
   - `tag`, `id`, `classes[]`, `name` attribute, `type` (Similo++), `aria-label` (Similo++), `href`, `alt`, `title`, `placeholder`.
   - `visibleText`.
   - `neighborText`: the text of nearby elements. Similo gives it weight 1.5.
   - `bbox {x,y,w,h}`, from which derive `area = w·h` and `shape = w·100/h`.
   - `isButton`.
   - Absolute `xpath` and `idxpath`.
   - `ancestorPath[]`: tag, id and classes for every ancestor from root to target, as Healenium's `Path` does.
   - Sources: [Similo.java LOCATORS](https://github.com/michelnass/SimiloLLM/blob/main/similollm/Similo.java); [Healenium Node/Path](https://repo1.maven.org/maven2/com/epam/healenium/tree-comparing/0.4.14/tree-comparing-0.4.14-sources.jar); [arXiv 2505.16424 (type, aria-label)](https://arxiv.org/pdf/2505.16424); [mabl (ancestors + custom test-id attrs)](https://help.mabl.com/docs/how-auto-heal-works). Today's schema already has `role, name, testId, id, css, containerRole/Name, path, frame, inShadow, nameSource` but no bbox, classes, neighbour text or ancestor attributes — [src/schema/appModel.ts](../../../../src/schema/appModel.ts).
2. **Volatile-id detection, run before the ladder and before scoring.**
   - **Why it is needed:** Playwright's `isGuidLike` returns *false* for `input-145`, `ember123`, `j_idt42`, `mui-7` and `react-select-3-input` ([OWN COMPUTATION on selectorGenerator.ts](https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts)).
   - **Detector, three layers:**
     - (a) Playwright's transition heuristic.
     - (b) A "word + counter" pattern, e.g. `/^[A-Za-z][\w-]*?[-_:]?\d+$/` or `/^:r[0-9a-z]+:$/`.
     - (c) Best of all, an **empirical check**: discover the same page twice, in two sessions, and mark any id that changed as volatile. This mirrors Sidereal, which learns fragility from earlier versions ([SEPL](https://sepl.dibris.unige.it/ROBULA.php)).
   - **What to do with a volatile id:**
     - Drop it from the CSS ladder.
     - Give it weight 0 in scoring.
     - Do not use it in path-LCS node equality, where Healenium equates nodes by tag + id ([Node.equals](https://repo1.maven.org/maven2/com/epam/healenium/tree-comparing/0.4.14/tree-comparing-0.4.14-sources.jar)).
     - Never fuzzy-match it. Healenium's Levenshtein on ids would score `input-145`→`input-146` at about 0.89 ([HeuristicNodeDistance](https://repo1.maven.org/maven2/com/epam/healenium/tree-comparing/0.4.14/tree-comparing-0.4.14-sources.jar)).
3. **Re-rank the emitted-locator ladder to match Playwright's published scores:**
   - Order: testId (1) < other data-test* (2) < role+name (100) < placeholder (120) < label (140) < alt (160) < text (180) < title (200) < `#id` (500, *stable ids only*) < role without name (510) < `input[name/type]` (520) < tag (530) < `nth` (10000, only if index ≤ 5).
   - Keep at most 2 levels of nesting, and no text in the parent when the target uses text.
   - Register `data-qa` as an extra `testIdAttribute`.
   - Sources: [selectorGenerator.ts](https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts); [locators.md](https://github.com/microsoft/playwright/blob/main/docs/src/locators.md).
4. **Replace the label-anchored `:below`/`:right-of` step,** because layout selectors are deprecated ([other-locators.md](https://github.com/microsoft/playwright/blob/main/docs/src/other-locators.md)).
   - Resolve proximity **at discovery time** and record it as `nameFromProximity` + `neighborText` + `bbox`.
   - Emit a structural locator instead: container role/name → `getByRole(role)` filtered with `has`/`hasText`, e.g. `getByRole('group').filter({ hasText: 'Full Name' }).getByRole('textbox')`. This follows the chaining/filter guidance in [best-practices-js.md](https://github.com/microsoft/playwright/blob/main/docs/src/best-practices-js.md).
   - If a layout selector is kept anyway, pass an explicit max-pixel argument. The default is unbounded except for `:near`'s 50 px.
5. **The deterministic healer's scoring formula,** taken from Similo's published weights and comparators ([Similo.java](https://github.com/michelnass/SimiloLLM/blob/main/similollm/Similo.java)). Here sᵢ ∈ [0,1] is the per-attribute similarity:
   - `score = Σ wᵢ·sᵢ`, with **w = 1.5** for tag, name, id (stable only), visibleText, neighborText, and **w = 0.5** for class, href, alt, xpath, idxpath, isButton, location, area, shape.
   - Double the visibleText weight when it is an exact match.
   - Comparators:
     - Equality for tag, name, id, isButton.
     - Normalised Levenshtein for class, href, alt, xpath, text. Jaro-Winkler is a candidate swap, per Similo++.
     - `location`: `max(200−dist_px,0)/200`.
     - `area`/`shape`: `(max−|a−b|)/max`.
     - `neighborText`: word-overlap weighted by characters.
   - **Normalise** by the sum of weights of attributes present on both sides. Similo's `calcMaxSimilarityScore` sums the weights present on the candidate.
   - Healenium's alternative weights, if a path signal is wanted as well: tag 100, LCS-path 100, id 50, class 40, text 30, other attributes 30, normalised by 350, with a hard 0 when depth > 5 and LCS/depth < 0.7 ([HeuristicNodeDistance](https://repo1.maven.org/maven2/com/epam/healenium/tree-comparing/0.4.14/tree-comparing-0.4.14-sources.jar)).
   - **Weights for type and aria-label are our proposal, not from the literature:** treat `aria-label` as 1.5, since it is often the accessible name in Lightning, and `type` as 0.5.
6. **VON Similo visual-overlap merge, for wrapped controls** (Lightning `<lightning-input>` wrapping a native `<input>`, label-in-span patterns).
   - Before scoring, merge the attributes of elements whose boxes overlap with IoU ≥ 0.85 or are contained, as multi-valued fields. Compare by taking the max over value pairs.
   - Sources: [Similo.java addOverlappingLocatorParameters](https://github.com/michelnass/SimiloLLM/blob/main/similollm/Similo.java); accuracy 0.783 → 0.879 per [arXiv 2301.03863](https://arxiv.org/pdf/2301.03863) (via search summary). The gain did not hold on a 2025 extended benchmark ([arXiv 2505.16424](https://arxiv.org/pdf/2505.16424)), so put it behind a flag and measure.
7. **False-heal guards. All must pass, or the heal is refused and the step fails loudly.** Similo's 91/801 errors were *all* silent wrong-element picks ([FinalResultsTable](https://github.com/michelnass/Similo2/blob/main/WidgetLocator/FinalResultsTable.txt)).
   - (a) **Score floor** on the normalised score. Healenium's default example is `score-cap 0.5` ([README](https://github.com/healenium/healenium-web)). Calibrate ours by artifact replay over `runs/`.
   - (b) **Outlier/margin test:** the top score must be ≥ `Q3 + 1.5·IQR` of the top-10 scores ([SimiloLLMTest higherOutlier](https://github.com/michelnass/SimiloLLM/blob/main/similollm/SimiloLLMTest.java)). Otherwise the case is "ambiguous" and goes to the LLM or a human.
   - (c) **Exactly-one-match:** the healed locator matches exactly one element, **and** that element is not already bound to another step in the same test ([HealingService](https://github.com/healenium/healenium-web/blob/master/src/main/java/com/epam/healenium/service/HealingService.java)).
   - (d) **Role compatibility:** keep our existing `COMPATIBLE_ROLE_GROUPS`. A textbox must never heal onto a button.
   - (e) **Never heal some step types:** absence or negative assertions ([Healenium @DisableHealing](https://github.com/healenium/healenium-web)); user-authored raw CSS/XPath steps ([mabl](https://help.mabl.com/docs/how-auto-heal-works)); steps whose locator a person edited ([Testim](https://testim.io/?p=6611)).
   - (f) **Assertions:** a heal may change an assertion's *locator*, never its *expected value*.
   - (g) **Re-check after healing:** re-run Playwright actionability on the healed element before acting ([actionability.md](https://github.com/microsoft/playwright/blob/main/docs/src/actionability.md)).
   - (h) **Allow a "functionality broken" verdict** that skips rather than heals ([Playwright healer](https://github.com/microsoft/playwright/blob/main/docs/src/test-agents-js.md)).
8. **LLM tie-break restricted to a shortlist.** Only when guard (b) says the case is ambiguous:
   - Send the top-10 candidates as compact JSON (multi-values joined by `||`) plus the stored target fingerprint.
   - Ask for **only a candidate id**.
   - Structurally verify that the id is in the shortlist, then apply guards (a), (c), (d) and (g) again.
   - Log separately whether the expected element was in the shortlist at all.
   - Source: [SimiloLLMTest.java prompt](https://github.com/michelnass/SimiloLLM/blob/main/similollm/SimiloLLMTest.java); the same layering is used by [mabl](https://help.mabl.com/docs/how-auto-heal-works) and [Katalon](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio). Vision diagnosis stays the last resort.
9. **Heal reporting and approval.** A heal applies to the current run only. Persisting it needs a person's approval, which matches this repo's rule 6 / D-27.
   - **Report row:** step id; old locator; new locator; selection method (ladder rung, scorer, or LLM); per-attribute score breakdown (Similo logs `total_similaity` per attribute); top-3 runner-ups with margins; before/after screenshots.
   - **Store** per environment, with rollback. Store **rejected heals as negative examples**, because a revert alone does not stop recurrence.
   - Sources: [Katalon Self-healing Insights + approve-to-persist](https://docs.katalon.com/katalon-studio/maintain-tests/self-healing-tests-in-katalon-studio); [Functionize yellow-tag flags](https://support.functionize.com/hc/en-us/articles/33000419162263-Debugging-Failed-Tests); [mabl per-environment history + rollback caveat](https://help.mabl.com/docs/how-auto-heal-works); [Testim "Improve" = update not override](https://help.testim.io/docs/editing-target-element-properties); [Similo.java](https://github.com/michelnass/SimiloLLM/blob/main/similollm/Similo.java).
10. **Readiness checks.**
    - **In generated specs:** never emit `waitForLoadState('networkidle')` or fixed sleeps ([params.md: networkidle DISCOURAGED](https://github.com/microsoft/playwright/blob/main/docs/src/api/params.md); [Cypress](https://github.com/cypress-io/cypress-documentation/blob/main/docs/app/core-concepts/best-practices.mdx)). Rely on locator actions' built-in checks (visible, stable for 2 frames, receives events, enabled, editable). Use `waitForURL` after navigations, and web-first `expect(...)` for state ([actionability.md](https://github.com/microsoft/playwright/blob/main/docs/src/actionability.md); [navigations.md](https://github.com/microsoft/playwright/blob/main/docs/src/navigations.md)).
    - **For SPAs and Lightning,** because of the hydration "click won't have any effect" caveat: after each navigation, emit an assertion on an **app-ready landmark** captured at discovery before the first interaction. For example, the target's container is visible *and* a known interactive element is enabled.
    - **Per-step timing:** record each step's observed time-to-actionable from passing runs, set per-step timeouts from that history, and flag drift ([mabl past-run timing](https://help.mabl.com/docs/how-auto-heal-works)).
    - **DOM-quiet waits:** if one is used in discovery, cap it hard. Katalon users report it can wait out its full 30 s on live-polling pages ([forum](https://forum.katalon.com/t/why-does-default-smart-wait-stops-working-all-of-the-sudden/87016)).
11. **Shadow DOM and iframe rules for both generator and healer.**
    - Never emit or score XPath (including ROBULA+ output and Similo's xpath/idxpath) for `inShadow` elements, because XPath does not pierce shadow roots ([locators.md](https://github.com/microsoft/playwright/blob/main/docs/src/locators.md)).
    - Identify iframes by `name`/`title`/test id, which codegen scores at 10 ([selectorGenerator.ts](https://github.com/microsoft/playwright/blob/main/packages/injected/src/selectorGenerator.ts)).
    - Scope healing candidates to the same `frame` chain the element was discovered in.
12. **ROBULA+ as a last-resort generator,** for a stable structural XPath when no semantic locator is unique and the element is not in shadow DOM.
    - Top-down refinement from `//*`.
    - Attribute priority `name, class, title, alt, value`.
    - Blacklist `href, src, onclick, onload, tabindex, width, height, style, size, maxlength`, plus **every volatile id from item 2**.
    - Sources: [robula-plus index.ts](https://github.com/cyluxx/robula-plus/blob/master/src/index.ts); [SEPL](https://sepl.dibris.unige.it/ROBULA.php). Fragility −63% vs Selenium IDE locators.

### Inferences
- The highest-leverage items for the Salesforce `input-145` problem are **2** (volatile-id detection), **3** (demote `#id` below role, name and label) and **7c/7b** (uniqueness, not-already-bound, and the margin gate). None needs an LLM, and all fit this repo's "deterministic check over IR/AppModel structure" rule.
- **Version constraint:** the project pins `@playwright/test` 1.49.0 ([package.json](../../../../package.json)). Playwright Test Agents arrived in 1.56, so the healer agent is not available without an upgrade. Per this repo's CLAUDE.md, `Locator.filter({ visible })` is also absent in the pinned version. Any generated API listed above should be executed once against synthetic HTML before shipping (DECISIONS.md D-19).
- Similo's weights were tuned on 48 public consumer sites. Before trusting the 1.5/0.5 split on Salesforce Lightning, replay saved `runs/*/02-appmodel.json` pairs from two sessions and measure accuracy and wrong-pick rate.

### Gaps
- No published weights exist for `aria-label`/`type` (Similo++), or for any commercial tool. The values in item 5 are our proposal.
- No literature value for the outlier/margin threshold beyond the IQR rule used in the SimiloLLM experiment code.
- Spinner/overlay-detection best practice and Virtuoso's approach remain unresearched (search budget exhausted). A follow-up session with fresh search quota should cover these, plus 2024–2026 LLM locator-repair papers.
