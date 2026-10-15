# Academic and open-source techniques for automated web-app exploration, modelling and LLM-driven web testing (state of the art as of Oct 2026)

Scope note for the report writer. These notes come from 37 targeted web searches, which used up the shared search budget, and from WebFetch on github.com, the only domain that resolved in this environment. WebFetch on arxiv.org, export.arxiv.org, ar5iv, people.ece.ubc.ca, *.github.io, usenix.org and huggingface.co all failed with DNS errors. So most paper details come from abstracts and search-result summaries, not from full texts. Tool details come from primary sources: GitHub READMEs and source files read directly. Each source is tagged **[peer-reviewed]**, **[preprint]**, **[repo/README]**, **[source code]** or **[aggregator/secondary]**.

Our pipeline today, for context. The screen fingerprint is URL + title (dialog name or first main heading) + selected tab + sorted field labels. The same-screen rule requires the same URL, the same title (or the same non-empty tab), and an overlap coefficient `|A∩B|/min(|A|,|B|) >= 0.7` (`SAME_SCREEN_OVERLAP`). The model is merged into the **first** match (`findIndex`), and the persistent screen map uses the same rule (`src/stages/screens.ts`, `src/stages/screenMap.ts`).

---

## 1. Crawling dynamic web apps / SPAs: state abstraction, "new state" detection, state explosion

### Takeaway
Crawljax-style event-driven crawling, which builds a state-flow graph of DOM states with event transitions, is still the baseline, and Crawljax's own master branch now ships pluggable DOM, visual and hybrid state abstractions plus FragGen-style fragment rules. The main research result (Yandrapally et al., ICSE 2020) is that **no single whole-page similarity threshold separates functional near-duplicates from distinct states without losing coverage**. Later work therefore moved to (a) fragment-level abstraction (FragGen), (b) learned, threshold-free classifiers or embeddings (WebEmbed, tree kernels), and (c) memoising deterministic transitions (SIBILLA).

### Cited Findings

**Crawljax foundations [peer-reviewed + repo]**
- Crawljax uses "an event-driven dynamic crawling engine" that explores JavaScript single-page apps. Its output is "a state-flow graph of the dynamic DOM states and the event-based transitions between them". It is extensible through plugins and licensed Apache-2.0. — [crawljax/crawljax README](https://github.com/crawljax/crawljax) [repo/README]
- The state-flow graph and invariant-based testing on top of it are described in the Mesbah / van Deursen / Roest ATUSA work (IEEE TSE). — [Mesbah et al., TSE (PDF)](https://people.ece.ubc.ca/amesbah/resources/papers/tse11.pdf) [peer-reviewed]; cited via [A Brief History of Web Crawlers, arXiv 1405.0749](https://arxiv.org/pdf/1405.0749) [preprint survey]
- Early Crawljax used an edit (Levenshtein) distance between DOM strings: if the distance was below a threshold, the new DOM was treated as the same state. Edit distance is **not transitive**, so it is not a true equivalence relation and can wrongly merge states. A later Crawljax version compares a new DOM against **all** previously discovered states and treats it as new only if it is farther than the threshold from every one. That costs storing every DOM and computing every distance. — [arXiv 1405.0749](https://arxiv.org/pdf/1405.0749); [LSH for Efficient Web App Security Testing, arXiv 2001.01128](https://arxiv.org/pdf/2001.01128) [peer-reviewed, ICISSP 2019]
- "Oracle Comparator Pipelining" (Roest et al., 2010) strips irrelevant substrings such as timestamps and ad banners from the DOM before hashing or comparing. It needs manual configuration per scan. — [arXiv 2001.01128](https://arxiv.org/pdf/2001.01128); [arXiv 1405.0749](https://arxiv.org/pdf/1405.0749)
- The comparators in Crawljax master today are `AttributeComparator`, `DateComparator`, `DummyComparator`, `EditDistanceComparator`, `PlainStructureComparator`, `RegexComparator`, `ScriptComparator`, `SimpleComparator`, `StyleComparator` and `XPathExpressionComparator`. — [Crawljax source, oraclecomparator/comparators](https://github.com/crawljax/crawljax/tree/master/core/src/main/java/com/crawljax/oraclecomparator/comparators) [source code]
- Crawljax master has a `stateabstractions` package with `dom/`, `visual/` and `hybrid/` sub-packages:
  - The DOM abstractions are `LevenshteinStateVertexFactory`, `RTEDStateVertexFactory` (with `RTED/` and `apted/` tree-edit-distance code) and `TLSHStateVertexFactory`, a locality-sensitive hash. — [Crawljax source, stateabstractions/dom](https://github.com/crawljax/crawljax/tree/master/core/src/main/java/com/crawljax/stateabstractions/dom) [source code]
  - The visual abstractions are `ColorHistogram`, `PDiff` (perceptual image differencing), `SIFT`, `SSIM` and an `imagehashes/` sub-package. — [Crawljax source, stateabstractions/visual](https://github.com/crawljax/crawljax/tree/master/core/src/main/java/com/crawljax/stateabstractions/visual); [stateabstractions](https://github.com/crawljax/crawljax/tree/master/core/src/main/java/com/crawljax/stateabstractions) [source code]
- Crawljax master also has a `fragmentation` package (`Fragment`, `FragmentManager`, `FragmentPair`, `FragmentRules`, `FragmentationPlugin`). The defaults in `FragmentRules` are `thresholdWidth = 50`, `thresholdHeight = 50`, `subtreeWidth_and = 1` and `subtreeWidth_or = 4`, used to decide whether a fragment is "useful". — [fragmentation package](https://github.com/crawljax/crawljax/tree/master/core/src/main/java/com/crawljax/fragmentation); [FragmentRules.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/fragmentation/FragmentRules.java) [source code]
- Crawl-control defaults in Crawljax master (`CrawlRules`):
  - `clickOnce = true`, `crawlNearDuplicates = true`, `delayNearDuplicateCrawling = true`, `skipExploredActions = true` with `maxRepeatExploredActions = 2`, and `randomizeCandidateElements = false`.
  - `followExternalLinks = false`, `crawlHiddenAnchors = false`, and `crawlEvents` defaults to `click`.
  - `formFillMode = NORMAL` (a `RANDOM` mode exists), and `waitAfterEvent` and `waitAfterReloadUrl` are 200 ms. The Javadoc says 500 ms, which contradicts the code.
  - The rules include backtracking options (`useEquivalentReset`, `avoidUnrelatedBacktracking`, `avoidDifferentBacktracking`, `restoreConnectedEdges`, all default false).
  - Source: [CrawlRules.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/configuration/CrawlRules.java) [source code]
- In `CrawljaxConfiguration`, `maximumStates = 0` (unlimited), `maximumDepth = 0` (unlimited; the Javadoc wrongly says 2) and `maximumRuntime = 1 hour`. The default `stateVertexFactory` is `DefaultStateVertexFactory`, with a `SimpleComparator` oracle added. — [CrawljaxConfiguration.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/configuration/CrawljaxConfiguration.java) [source code]
- OWASP ZAP's AJAX Spider is a Crawljax-based add-on. Its max crawl depth defaults to 10 (0 = unlimited), it has a max crawl states option (0 = unlimited), "click elements once" is on by default, and it has a "random values in form fields" option. — [ZAP AJAX Spider options](https://www.zaproxy.org/docs/desktop/addons/ajax-spider/options/) [vendor docs]
- One Crawljax extension (metamorphic security testing) computes the edit distance between a new page and the cached page of each known state, and calls them the same state if the distance is below **5% of the page length**. — [Metamorphic Testing for Web System Security, arXiv 2208.09505](https://arxiv.org/pdf/2208.09505); [arXiv 1912.05278](https://arxiv.org/pdf/1912.05278) [preprints; the TSE version is peer-reviewed]
- A TU Delft thesis implemented Simhash ("Crawlhash") and Broder's shingling in Crawljax. Crawlhash was faster and Broder slightly more accurate. The thesis built a "threshold-slider" to simulate how the state-flow graph changes with the threshold, so a threshold can be tuned per application. — [TU Delft thesis](https://repository.tudelft.nl/file/File_2e95e62f-b3f6-4e94-b735-7dfed8947bac?preview=1) [thesis]
- Ben-Bassat & Rokah use **MinHash LSH** sketches of the DOM structure to estimate state similarity efficiently. They note that exact hashes are too strict for near-duplicate pages and that all-pairs distance is infeasible on large RIAs, and report that LSH allowed scanning RIAs that could not be crawled otherwise. — [arXiv 2001.01128](https://arxiv.org/pdf/2001.01128) [peer-reviewed, ICISSP 2019]

**Near-duplicate detection research**
- **Yandrapally, Stocco, Mesbah, "Near-Duplicate Detection in Web App Model Inference" (ICSE 2020, pp. 186-197)**
  - The authors classified a random sample of state pairs, drawn from 493k web-page pairs across 6,000+ websites, as **clone / near-duplicate / distinct**. They then computed per-technique thresholds for the boundaries between these classes.
  - They evaluated **10 techniques** from information retrieval, web testing and computer vision on 9 open-source apps.
  - Main finding: "no algorithm is able to accurately detect all functional near-duplicates within apps, without sacrificing coverage."
  - Sources: [ICSE 2020 program page](https://conf.researchr.org/details/icse-2020/icse-2020-papers/102/Near-Duplicate-Detection-in-Web-App-Model-Inference); [ACM DL](https://dl.acm.org/doi/abs/10.1145/3377811.3380416) [peer-reviewed]
  - The 9-app labelled dataset (97,500 state pairs labelled clone, near-duplicate or distinct) was reused by later work. All 9 apps are CRUD apps (login, add user...) and so functionally similar. — [Neural Embeddings for Web Testing, arXiv 2306.07400](https://arxiv.org/pdf/2306.07400) [preprint]
- **FragGen (Yandrapally & Mesbah, "Fragment-Based Test Generation for Web Apps", IEEE TSE 49(3):1086-1101, 2023; ICSE 2023 journal-first)**
  - FragGen replaces whole-page threshold comparison with **page fragmentation**: "a web page is not a singular functional entity", so fragments are compared to decide functional equivalence, and no thresholds are needed.
  - Results: on 86,165 state pairs it detected 123% more near-duplicates than whole-page techniques. Its crawl models had 62% more precision and 70% more recall. Its generated oracles detected 98.7% of visible changes.
  - Sources: [arXiv 2110.14043](https://arxiv.org/abs/2110.14043v1); [ICSE 2023 JF page](https://conf.researchr.org/details/icse-2023/icse-2023-journal-first-papers/59/Fragment-Based-Test-Generation-For-Web-Apps); [dblp](https://dblp1.uni-trier.de/pid/148/1336.html) [peer-reviewed]
  - **Actionable equivalence:** two actionables (such as buttons) are equivalent when the fragments containing them are classified clone or near-duplicate **and** their relative XPaths within the fragment match.
  - **Prioritisation:** each actionable is scored by its equivalents across states, and states are ranked by summed scores. "Every time an actionable is explored, FRAGGEN de-prioritizes all of its equivalent actionables to diversify the exploration." In practice, repeated navigation links get explored once and are then deprioritised everywhere.
  - Later work describes FragGen as a hybrid that combines structural and visual aspects.
  - Source for these three points: [arXiv 2110.14043 (search summary of PDF; equations garbled in extraction)](https://arxiv.org/pdf/2110.14043)
- **WebEmbed (Stocco et al., "Neural Embeddings for Web Testing", arXiv 2306.07400)**
  - WebEmbed replaces threshold-based equivalence with neural embeddings plus threshold-free classifiers.
  - On 9 apps it reports +22% precision and +24% recall for near-duplicate detection, and +23% average code coverage of the generated test suites (range 2-59%).
  - Source: [arXiv 2306.07400](https://arxiv.org/pdf/2306.07400) [preprint; the venue was not confirmed in this session]
  - A later paper describes WebEmbed as Doc2Vec pre-trained on unlabelled web pages. — [WebRLED, arXiv 2504.19237](https://arxiv.org/html/2504.19237v1) [preprint]
  - **Conflict:** the arXiv HTML v2 lists different authors and describes transformer-based Siamese networks. Check which version is cited. — [arXiv 2306.07400v2](https://arxiv.org/html/2306.07400v2)
- **Tree kernels (Corazza, Di Martino, Peron, Starace, ESEM 2021)** use tree-kernel functions over DOM trees to classify near-duplicate state pairs. On ~100k annotated pairs, they report better classification than state-of-the-art techniques in preliminary experiments. — [arXiv 2108.13322](https://arxiv.org/html/2108.13322v1) [peer-reviewed, ESEM 2021]
- **SIBILLA ("Guess the State", Clerissi, Denaro, Mobilio, Mariani; IEEE TSE 50(4):836-853, 2024)** observes that test generators spend most of their time analysing screens after each action. It "identif[ies] and memoize[s] the deterministic behaviors of the software, in order to infer recurring GUI states". Evaluated with Random, DFS and Q-learning explorers on 9 systems, it cut test-generation time by **22%-96%**. — [Univ. Milano-Bicocca repository (open access)](https://boa.unimib.it/handle/10281/462218); [ACM DL](https://dl.acm.org/doi/abs/10.1109/TSE.2024.3366586) [peer-reviewed]
- **SoK: State of the Krawlers (Stafeev & Pellegrino, USENIX Security 2024)**
  - The authors reimplemented a decade of crawling algorithms in the "Arachnarium" framework and evaluated them on 9 real apps, 2 benchmark apps and the top 10K CrUX sites.
  - **Commonly used crawling algorithms reached less coverage than randomised ones**, and no single crawler configuration was best.
  - Many papers described their crawlers too vaguely to reimplement.
  - Sources: [USENIX page](https://www.usenix.org/conference/usenixsecurity24/presentation/stafeev); [CISPA summary](https://cispa.de/en/stafeev-webcrawlers) [peer-reviewed]
- **Empirical study (Liu, Yang, Zhang, Xie, arXiv 2606.16650, June 2026)**
  - The study compares model-based, RL-based and LLM-based web GUI testing across **six state abstractions**.
  - No strategy dominates. RL reaches the highest coverage, while LLM-based testers find failures the others miss.
  - **Precise abstractions help model-based exploration, while compact abstractions matter more for RL.**
  - For LLM testers, "concise functionality-level history" improves coverage and failure detection by reducing context overflow.
  - Sources: [arXiv 2606.16650](https://arxiv.org/pdf/2606.16650); [Emergent Mind summary](https://www.emergentmind.com/papers/2606.16650) [preprint + secondary]

### Inferences
- Our overlap-coefficient rule is a hand-set, whole-screen threshold over labels, which is exactly the family Yandrapally et al. found cannot be tuned to catch all near-duplicates without losing coverage. Restricting it to dialog or main-content elements and excluding header/nav/footer is already a coarse version of FragGen's fragment idea, applied to one fragment.
- Our merge uses `findIndex`, so a capture merges into the **first** stored screen above 0.7, not the closest one. This is the non-transitivity problem Crawljax fixed by comparing against all known states. With several near-duplicate screens per URL, the merge result can depend on storage order.
- `|A∩B|/min(|A|,|B|)` scores 1.0 when one label set is a **subset** of the other. A wizard whose step 2 repeats all of step 1's fields under the same heading and adds more would merge into step 1. A Jaccard or containment-asymmetry check would separate these (see Adoptable techniques, T1).
- SIBILLA's 22-96% savings point at our persistent screen map as a memo table. A `(screen, action) -> screen` edge seen repeatedly with the same outcome could skip re-capture and re-analysis on later runs.
- SoK Krawlers suggests that a simple randomised frontier with good state abstraction and click-once rules is a strong baseline. Elaborate prioritisation should only be added if it beats random on our own sites.

### Gaps
- I could not get the **numeric thresholds** Yandrapally et al. computed per technique, or which of the 10 techniques scored best: the full PDF did not resolve and search summaries stop at the abstract. One search summary said a later paper reports RTED (tree edit distance) as the best performer in Yandrapally et al., but I could not identify or verify the citing paper. Treat that as an unverified lead.
- I could not get FragGen's exact fragmentation algorithm (how visual and DOM cues partition the page) or its exact equations. Crawljax's `FragmentRules` defaults (50x50 px, subtree widths 1/4) are visible, but the code that applies them was not read.
- I did not verify WebEmbed's venue or which version (Doc2Vec vs Siamese) is canonical.

---

## 2. Model-based testing from inferred models (state graphs, page-object inference, graph-driven test synthesis)

### Takeaway
Inferred state graphs are used to (a) generate tests by path enumeration over the graph, (b) derive page objects by clustering states, and (c) give LLMs structured context. 2025-2026 LLM work uses screen/state graphs for **deterministic navigation prefixes**, such as shortest paths, and leaves the LLM to verbalise or verify each step.

### Cited Findings
- **APOGEN (Stocco, Leotta, Ricca, Tonella; Software Quality Journal 2016; ICWE 2016)**
  - APOGEN reverse-engineers a web app into a model, then uses **clustering + static analysis** to group pages into page objects and emit Java/Selenium page-object classes.
  - The clusters were close to a human's, averaging 3 differences per app. 75% of generated code was usable as-is, and 84% of generated assertion-support methods were useful.
  - Sources: [ICWE 2016 full paper (PDF)](https://sepl.dibris.unige.it/publications/2016-stocco-ICWE-full.pdf); [SQJ 2016 (PDF)](https://sepl.dibris.unige.it/publications/2016-stocco-SQJ.pdf); [APOGEN page](https://sepl.dibris.unige.it/APOGEN.php) [peer-reviewed]
- **FragGen** generates tests and regression oracles from its fragment-based model, and its oracles detected 98.7% of visible changes. — [arXiv 2110.14043](https://arxiv.org/abs/2110.14043v1) [peer-reviewed, TSE]
- **"Automated Web Application Testing: End-to-End Test Case Generation with LLMs and Screen Transition Graphs" (Le et al., JAIST/Amifiable, arXiv 2506.02529, v2 Feb 2026)**
  - The system builds a screen transition graph with Selenium crawling.
  - For navigation tests, it uses **Dijkstra to find the shortest path between two screens**, has an LLM describe the action for each edge, and composes the edges into one executable test with expected results.
  - **Conditional forms** use a separate state graph.
  - An aggregator lists GPT-4o micro-accuracy at about 95% / 79% / 90% on NL / dynamic-form / real-world-form tasks. I could not verify these figures.
  - Source: [arXiv 2506.02529v2](https://arxiv.org/html/2506.02529v2) [preprint]
- **AutoE2E (Alian et al., UBC; ICSE 2025)**
  - AutoE2E explores breadth-first, records states and actions, and **infers candidate "features" with confidence scores** that are updated as new observations arrive. It stores them in a Feature DB and an Action-Feature DB, then turns each feature into an E2E test.
  - It also introduces the E2EBench benchmark, on which it reports 79% average feature coverage, +558% over the best baseline.
  - Sources: [arXiv 2408.01894](https://arxiv.org/html/2408.01894v1); [ICSE 2025 page](https://conf.researchr.org/details/icse-2025/icse-2025-research-track/61/Feature-Driven-End-To-End-Test-Generation) [peer-reviewed]
- **VISCA (Alian, Tang, Mesbah, arXiv 2506.04161, June 2025)**
  - VISCA heuristically segments pages into candidate segments, then a multimodal LLM classifies them into a fixed vocabulary of UI components with context. The result is a **hierarchical component abstraction** used as LLM context for feature inference.
  - It reports 92% average feature coverage, 16% above AutoE2E.
  - Source: [arXiv 2506.04161](https://arxiv.org/abs/2506.04161v1) [preprint]
- **AutoDroid (Wen et al., MobiCom 2024, Android)**
  - The system has an offline exploration phase that builds app knowledge, which is then **injected into prompts as memory** at run time. Its parts are a functionality-aware UI representation, exploration-based memory injection, and multi-granularity query optimisation.
  - On 158 tasks with GPT-4 it reports 90.9% action accuracy and 71.3% task success, +36.4% and +39.7% over GPT-4 baselines.
  - Sources: [arXiv 2308.15272](https://arxiv.org/pdf/2308.15272); [alphaXiv overview](https://alphaxiv.org/overview/2308.15272v4) [peer-reviewed + secondary]

### Inferences
- Our persistent screen map, with "click X on screen A -> screen B" edges used as LLM hints, is architecturally the same idea as AutoDroid's exploration-based memory injection and the STG paper's graph. The STG paper suggests a stronger use: **compute the navigation prefix deterministically from the graph** (shortest path to the target screen), so the LLM only writes the test-specific steps. That removes a whole class of "missing step" failures.
- Clustering screens into page objects (APOGEN) maps naturally onto grouping our screens by URL plus title family. It would give the LLM a compact, functionality-level summary, the history format the 2026 empirical study found best for LLM testers.

### Gaps
- I did not find a 2024-2026 paper that measures how much **graph-derived navigation prefixes** reduce LLM test-generation errors compared with free LLM planning. The STG paper reports accuracy but, from the summaries I could read, no ablation.

---

## 3. Exploration strategies: RL / curiosity-driven, and LLM-agent exploration

### Takeaway
RL explorers (WebExplor, UniRLTest/PIRLTest, WebRLED) use **curiosity rewards based on state novelty** and reach the highest coverage. LLM explorers (DroidAgent, AutoE2E, NaviQAte, VETL) add semantic, intent-driven actions and realistic inputs and find failures RL misses, but they are costly. The 2025-2026 trend is **hybrid**: cheap systematic exploration, with the LLM used sparingly to maintain abstract knowledge (LLM-Explorer reports 148x lower cost) and to supply text inputs.

### Cited Findings
- **WebExplor (Zheng et al., ICSE 2021)** is end-to-end web testing with **curiosity-driven RL**. It incrementally builds an automaton during online testing to give "high-level guidance". It reported higher failure detection, code coverage and efficiency than prior web testing tools, plus 12 previously unknown failures found in a commercial app. — [ICSE 2021 page](https://2021.icse-conferences.org/details/icse-2021-papers/21/Automatic-Web-Testing-using-Curiosity-Driven-Reinforcement-Learning); [arXiv 2103.06018](https://arxiv.org/abs/2103.06018v1) [peer-reviewed]
- **UniRLTest (ISSTA 2022 tool demo) / PIRLTest (arXiv 2208.09116)**
  - The approach is platform-independent: it uses CV widget detection on screenshots to build a widget tree per page.
  - It uses a DQN in which each widget tree is a state and each executable action is an action, with a curiosity reward pushing toward rarely explored pages.
  - It was evaluated on 20 mobile and 5 web apps; PIRLTest v2 reports +1.5-51.1% code coverage on web apps and 128 unique bugs.
  - The rename from UniRLTest to PIRLTest is likely but not confirmed.
  - Sources: [ISSTA 2022 demo page](https://conf.researchr.org/details/issta-2022/issta-2022-tool-demonstrations/5/UniRLTest-Universal-Platform-Independent-Testing-with-Reinforcement-Learning-via-Ima); [arXiv 2208.09116v2](https://arxiv.org/html/2208.09116v2) [peer-reviewed demo + preprint]
- **WebRLED (arXiv 2504.19237, 2025)**
  - **Grid-based action value learning:** the page is split into an N×N grid, and a DQN predicts a value per cell. An action's value is the sum of the values of cells within a circle of radius **1.5× cell length** centred on the element. This addresses "action misalignment" when the action set changes between pages.
  - It also has a trainable **action discriminator** to find more actionable elements, and an adaptive **curiosity reward based on the novelty of the state within the episode and across global history**.
  - A third-party review says it uses WebEmbed for state abstraction (unverified).
  - Sources: [arXiv 2504.19237](https://arxiv.org/html/2504.19237v1) [preprint]; [Moonlight review](https://www.themoonlight.io/fr/review/deep-reinforcement-learning-for-automated-web-gui-testing) [secondary]
- **Empirical comparison (arXiv 2606.16650, 2026):** RL reaches the highest coverage, LLM-based testers find unique failures, compact abstractions suit RL, and concise functionality-level history suits LLM testers. — [arXiv 2606.16650](https://arxiv.org/pdf/2606.16650) [preprint]
- **DroidAgent (Yoon, Feldt, Yoo; ICST 2024, Android)**
  - DroidAgent is an autonomous, intent-driven GUI testing agent that uses LLMs with long- and short-term memory. It produces high-level scenarios plus executable UIAutomator2 scripts.
  - On 15 Themis apps it reports 61% activity coverage, against 51% for the prior state of the art.
  - 317 of 547 self-generated tasks were judged realistic and relevant. The arXiv v1 reports 374 instead, so the versions differ.
  - Sources: [Chalmers record](https://research.chalmers.se/en/publication/542878); [arXiv 2311.08649](https://arxiv.org/abs/2311.08649v1); [coinse/droidagent](https://github.com/coinse/droidagent) [peer-reviewed + repo]
- **LLM-Explorer (Zhao, Wen, et al., arXiv 2505.10593, 2025, Android)**
  - The authors argue that per-step LLM calls are "neither necessary nor effective". The LLM instead **maintains an abstract knowledge base of states and actions**, and action selection is done mostly without LLM calls.
  - On 20 apps against 5 baselines it reports the fastest and highest coverage at **>148x lower cost**: about $0.11 per run versus $16.31 for DroidAgent and $1.07 for GPTDroid. The cost basis was not verified.
  - It also reports reduced redundant state and action visits per abstract state.
  - Source: [arXiv 2505.10593](https://arxiv.org/pdf/2505.10593) [preprint]
- **NaviQAte (Shahbandeh, Alian, Nashid, Mesbah; arXiv 2409.10741)**
  - NaviQAte treats web navigation for a functionality as **question answering**. It runs in three phases with model tiering: GPT-4o for hard decisions, GPT-4o-mini for simple ones.
  - On Mind2Web-Live it reports 44.23% user-task and 38.46% functionality-navigation success, +15% and +33% over WebCanvas. The UBC thesis version reports different numbers.
  - Sources: [arXiv 2409.10741](https://arxiv.org/html/2409.10741v1); [UBC thesis](https://open.library.ubc.ca/cIRcle/collections/24/items/1.0447635) [preprint + thesis]
- **VETL (arXiv 2410.12157)** uses a large vision-language model for web GUI testing. Its two subtasks are **text input generation** and **"interested element" identification**. It offers three variants because LVLM calls are costly, plus fallbacks for malformed model output. — [arXiv 2410.12157](https://arxiv.org/pdf/2410.12157) [preprint]
- **Web-agent benchmarks, for calibrating expectations of LLM navigation reliability:**
  - The original WebArena GPT-4 agent scored 14.41% task success, against 78.24% for humans. — [aiwiki WebArena](https://aiwiki.ai/wiki/webarena) [secondary]
  - Aggregators in mid-2026 list top WebArena systems at about 72-74%: WebTactix on DeepSeek v3.2 at 74.3%, OpAgent at 71.6%. These are full harnesses, not bare models, and are not directly comparable across sources. — [Steel.dev leaderboard](https://leaderboard.steel.dev/leaderboards/webarena.md); [capitalandcompute WebArena](https://capitalandcompute.net/ai-benchmarks/webarena/) [aggregator]
  - On VisualWebArena, GPT-4V with Set-of-Marks beats the accessibility-tree version by only about 1.3 points. — [benchmarklist VisualWebArena](https://benchmarklist.com/benchmarks/visualwebarena/) [aggregator]
- **SeeAct (Zheng et al., ICML 2024)**
  - GPT-4V can complete 51.1% of live-website tasks **if its textual plans are grounded into actions manually**. The authors say "grounding still remains a major challenge".
  - They also argue that HTML is noisier and less information-dense than rendered visuals.
  - Sources: [arXiv 2401.01614](https://arxiv.org/pdf/2401.01614); [ICML 2024](https://icml.cc/virtual/2024/poster/33031) [peer-reviewed]

### Inferences
- For our button-driven SPA gap, the evidence favours a **systematic explorer with novelty-based prioritisation and click-once / skip-explored rules** (Crawljax, FragGen, the curiosity explorers). An LLM should be used only to (i) propose text inputs and (ii) label screens and features at an abstract level, not to choose every click. That matches LLM-Explorer's cost result and the 2026 study's finding on what each strategy is good at.
- A full RL explorer (DQN, grid values) is overkill for a per-run discovery budget of minutes. The transferable piece is the **count-based curiosity signal**: prefer actions leading to unseen or rarely seen screens, scored both within this run and in the persistent map's global history (WebRLED's within-episode + global novelty).
- The benchmark numbers (WebArena ~72-74% at best with heavy harnesses, SeeAct's grounding gap) support keeping the LLM out of execution-time element selection. The current deterministic grounding is the right call.

### Gaps
- I could not confirm whether WebExplor's automaton is a DFA, or what its exact curiosity formula is.
- I found no web-specific (non-Android) replication of LLM-Explorer's cost and coverage claim.

---

## 4. LLM test generation for web: grounding (accessibility tree, Set-of-Marks, candidate ranking), verification, success rates and failure modes

### Takeaway
The consistent pattern in the state of the art is **"the model chooses from a closed set; code resolves the choice."** The variants are MindAct's ranker + multiple choice, Playwright MCP's snapshot refs, Stagehand's `observe` returning real selectors, and WebTestPilot's symbolised elements. The main failure mode is still **grounding** (hallucinated or wrong elements), followed by **unsoundness**: false failures from ambiguous steps or nondeterministic agents. That is countered with per-step guardrails and repeat-run consistency checks.

### Cited Findings
- **Mind2Web / MindAct**
  - Stage 1: a fine-tuned **small cross-encoder LM ranks all DOM elements** against the task and step and keeps the top-k.
  - Stage 2: a large LM picks the action as a **multiple-choice question** over the candidates.
  - Source: [Mind2Web, arXiv 2306.06070](https://arxiv.org/pdf/2306.06070) [preprint record; the venue was not verified in this session]
  - Implementations vary: the top 50 elements turned into 10 MCQs (a sustainability-metrics paper); 5 candidates per round (AgentBench); and groups of 5 options **including "None"**, iterated until one remains (CVPR 2024 supplement). — [arXiv 2502.17903](https://arxiv.org/pdf/2502.17903); [AgentBench, arXiv 2308.03688](https://arxiv.org/pdf/2308.03688); [Dual-View Visual Contextualization CVPR 2024 supplement](https://openaccess.thecvf.com/content/CVPR2024/supplemental/Kil_Dual-View_Visual_Contextualization_CVPR_2024_supplemental.pdf) [mixed]
  - A community DeBERTa-v3 ranker reports recall@10 of about 93%, plateauing around k≈20. Unofficial. — [HF model card](https://huggingface.co/torontodeveloper/mind2web-candidate-ranker) [secondary]
- **SeeAct** shows that LMM plans are good while grounding is the bottleneck: 51.1% success with oracle grounding. — [arXiv 2401.01614](https://arxiv.org/pdf/2401.01614) [peer-reviewed]
- **Playwright MCP (Microsoft)**
  - It uses "Playwright's accessibility tree, not pixel-based input".
  - Action tools take a `target`, "exact target element reference from the page snapshot, or a unique element selector", plus a human-readable `element` description used for permission.
  - `browser_take_screenshot` cannot be acted on, and vision (x,y) tools are opt-in via `--caps=vision`.
  - `--caps=testing` adds `browser_generate_locator` and `browser_verify_*` tools, and `--codegen` defaults to `typescript`.
  - Source: [microsoft/playwright-mcp README](https://github.com/microsoft/playwright-mcp) [repo/README]
- **WebTestPilot (DOI 10.1145/3797115; arXiv 2602.11724)**
  - It targets VLM-agent hallucinations that blur "model error vs real bug". Critical GUI elements are **detected and abstracted into symbolic variables**, and assertion generation is constrained to operations over those symbols.
  - The symbolic state tracks data, causal and temporal dependencies across states.
  - On a no-code platform it found 8 bugs (data binding, UI, navigation).
  - Sources: [arXiv 2602.11724](https://arxiv.org/html/2602.11724v1); [DOI](https://doi.org/10.1145/3797115) [peer-reviewed per DOI/ISSN listing]
- **Soundness of NL test execution by LLM agents (Salva & Taguelmimt, ENASE 2026)**
  - "NL test cases are inherently unsound because ambiguous instructions or unpredictable agent behaviour can produce false failures."
  - The authors propose specialised agents plus **guardrails that verify each step**, an **execution-consistency** measure, and a "weak unsoundness" notion.
  - Of eight 3B-70B open models, only Llama 3.1/3.3 70B met consistency above the 3-sigma level.
  - Sources: [arXiv 2509.19136v2](https://arxiv.org/html/2509.19136v2); [ENASE page](https://perso.limos.fr/~sesalva/publication/enase-salva-s-26/) [peer-reviewed]
- **Stagehand (Browserbase)**
  - `observe()` "returns real selectors, so credentials never reach the model"; `act()` "self-heals when the site redesigns".
  - `act`, `observe` and `extract` "refresh how an action happens when the site changes underneath it".
  - Server-side caching means "identical calls come back from Browserbase, no tokens spent".
  - It uses "hybrid accessibility-tree trimming".
  - Source: [browserbase/stagehand README](https://github.com/browserbase/stagehand) [repo/README]
- **Healenium (EPAM)** wraps WebDriver as a `SelfHealingDriver`. On a locator failure it proposes healed locators; `recovery-tries` sets how many candidates are tried and `score-cap` sets the minimum match score (the example value is `0.5`, i.e. at least 50% match). `@DisableHealing` turns healing off where an element is expected to be absent. — [healenium/healenium-web README](https://github.com/healenium/healenium-web) [repo/README]
- **AutoE2E / VISCA:** the context given to the LLM is the main bottleneck. A component-level abstraction lifted feature coverage from 79% (AutoE2E) to 92% (VISCA). — [arXiv 2506.04161](https://arxiv.org/abs/2506.04161v1); [arXiv 2408.01894](https://arxiv.org/html/2408.01894v1)
- Other 2025-2026 entries in this space whose details I could not read: WebTestBench, a benchmark of computer-use agents on E2E web testing ([arXiv 2603.25226](https://arxiv.org/html/2603.25226v1)), and GenIA-E2ETest, NL-to-E2E scripts ([arXiv 2510.01024](https://arxiv.org/html/2510.01024v1)). [preprints]

### Inferences
- Our IR grounding (the LLM names a target, `groundingError()` verifies it against discovered elements) is the same pattern as the closed-set designs above. The research suggests two upgrades:
  - (a) **give the LLM the candidate list explicitly, with stable ids**, as MCQ or refs, plus a "None of these" option, instead of free-text targets that are matched afterwards;
  - (b) **rank candidates deterministically before prompting**, using role, name similarity and screen membership, so the prompt holds top-k per step rather than the whole screen.
- WebTestPilot's symbolisation backs our structural-over-textual rule: assertions should reference discovered element ids or symbols, not prose.
- Salva & Taguelmimt's repeat-run consistency metric is cheap to adopt for our executor: run a newly generated test N times and flag nondeterministic verdicts before reporting a failure as a real bug.

### Gaps
- I found no rigorous public numbers on **hallucinated-element rates** for LLM-written web test steps, as opposed to agent task success. Most papers report end-to-end success or coverage.
- I could not read SeeAct's breakdown of Set-of-Marks vs textual-choice grounding.

---

## 5. Safety in exploration: avoiding destructive actions

### Takeaway
Academic crawlers handle safety with **configuration**: `dontClick` rules, click-once, crawl scope and no external links. Agent-safety research (WebGuard, ST-WebAgentBench, SafeArena) shows that **LLMs are poor judges of action risk**: frontier models fall below 60% accuracy on predicting action outcomes and on recall of HIGH-risk actions. So safety must be enforced deterministically, outside the model.

### Cited Findings
- **WebGuard (OSU / Scale AI / UC Berkeley, arXiv 2507.14293, July 2025)**
  - The dataset has 4,939 human-annotated **state-changing** actions from 193 sites in 22 domains, labelled with a three-tier risk schema **SAFE / LOW / HIGH**, each verified by three reviewers.
  - Frontier LLMs scored **below 60% accuracy on predicting action outcomes and below 60% recall on HIGH-risk actions**.
  - A fine-tuned Qwen2.5-VL-7B rose from 37% to 80% accuracy and from 20% to 76% HIGH-risk recall.
  - Sources: [arXiv 2507.14293](https://arxiv.org/pdf/2507.14293); [Scale research page](https://scale.com/research/webguard) [preprint]
- **ST-WebAgentBench (arXiv 2410.06703)**
  - The benchmark has 222 tasks on GitLab, ShoppingAdmin and SuiteCRM with 646 policy instances. The six policy dimensions are user-consent, boundary, strict execution, hierarchy, robustness and error-handling.
  - Its **Completion-under-Policy** metric gives credit only if all policies hold. Agents' CuP was below two-thirds of their nominal completion.
  - It includes human-in-the-loop hooks for deferring or escalating.
  - Venue and author attribution conflict between sources: IBM lists ICML 2025, while arXiv and a review site say ICLR 2025.
  - Sources: [arXiv 2410.06703v4](https://arxiv.org/html/2410.06703v4); [IBM Research listing](https://research.ibm.com/publications/st-webagentbench-a-benchmark-for-evaluating-safety-and-trustworthiness-in-web-agents) [preprint/peer-reviewed, venue unclear]
- **SafeArena** is a benchmark of the safety of autonomous web agents; I read no details. — [arXiv 2503.04957](https://arxiv.org/pdf/2503.04957) [preprint]
- **Crawljax safety levers:**
  - `dontClick(...)` and `dontClickChildrenOf(...)` exclusion rules, `clickOnce = true` and `followExternalLinks = false`.
  - A crawl scope that defaults to the start URL's site.
  - Configurable `crawlEvents` (click only by default).
  - Sources: [CrawlRules.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/configuration/CrawlRules.java); [CrawljaxConfiguration.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/configuration/CrawljaxConfiguration.java) [source code]
- **Playwright MCP:**
  - `--allowed-origins` and `--blocked-origins` are evaluated blocklist-first, and the README states they do "not serve as a security boundary"; Playwright MCP "is **not** a security boundary".
  - `--isolated` keeps the profile in memory.
  - Network tools (`browser_route`, `browser_network_requests`) are opt-in via `--caps=network`.
  - `browser_run_code_unsafe` is "RCE-equivalent".
  - Source: [playwright-mcp README](https://github.com/microsoft/playwright-mcp) [repo/README]
- The ZAP AJAX Spider's "click elements once" default is a safety and efficiency trade-off: turning it off "is more thorough but can take much longer". — [ZAP AJAX Spider options](https://www.zaproxy.org/docs/desktop/addons/ajax-spider/options/) [vendor docs]

### Inferences
- WebGuard's numbers are the strongest evidence-based argument for our design rule: **do not let the LLM decide whether an exploratory click is safe**. A base model's HIGH-risk recall was 20%.
- A deterministic policy should combine:
  - (1) **structural signals**: the element is a submit button of a form with a non-GET method, the element sits inside a `dialog` whose other button is "Cancel", or the role is `button` with a destructive accessible name;
  - (2) **network-level enforcement during discovery**: abort non-GET XHR/fetch and form posts except an allowlisted login endpoint, via Playwright `page.route`. This is structural and does not depend on page wording.
- A name regex (delete, remove, pay, purchase...) is a page-text check. Per CLAUDE.md's TD-01 lesson, it can be used only as an extra deny signal, never as the only guard.
- ST-WebAgentBench's CuP framing suggests reporting discovery coverage **under policy**, i.e. how many screens were reached without any blocked mutation, so the safety policy's coverage cost is visible.

### Gaps
- I found no academic web-crawler paper that evaluates a **network-request-blocking** safety policy against coverage. The recommendation above is an inference, not a measured result.
- I could not read WebGuard's exact definitions of LOW vs HIGH, or SafeArena's harm categories.

---

## 6. Form filling: inferring valid inputs from constraints and labels; validation feedback loops

### Takeaway
Form inputs are the main blocker to deeper exploration. The best-documented technique is **FormNexus (ISSTA 2024)**: build a per-field semantic graph, have the LLM infer constraints, **refine them from real submission feedback**, then generate valid and constraint-violating tests. Empirical studies agree that **complete, cleanly pruned form context** in the prompt is the biggest lever.

### Cited Findings
- **FormNexus (Alian, Nashid, Shahbandeh, Mesbah; ISSTA 2024)**
  - It derives per-field semantics from text, DOM structure and visual layout into a **Form Entity Relation Graph (FERG)**.
  - The LLM proposes input constraints and **revises them using feedback from real form-submission responses**. Tests are then generated by deliberately violating the constraints.
  - With GPT-4 it reached **89% coverage of form-submission states**, 25 points above the best baseline.
  - Source: [arXiv 2402.00950](https://arxiv.org/html/2402.00950v2) [peer-reviewed]
- **LLMs for web-form test generation (Li, Cui, Ma, Towey, Xie, Huang; TOSEM / ASE 2025 journal-first)**
  - The study ran 11 LLMs on 146 forms from 30 Java web apps.
  - GPT-4, GLM-4 and Baichuan2 were best. Other models' successfully-submitted rate was 9.10%-74.15% lower than GPT-4's.
  - **Prompts with complete, clear form context produced better tests.**
  - Of three HTML-pruning methods, the **parser-processed variant (PH-P)** had the highest successfully-submitted rate.
  - Sources: [arXiv 2405.09965](https://arxiv.org/pdf/2405.09965); [ASE 2025 JF page](https://conf.researchr.org/details/ase-2025/ase-2025-journal-first-track/36/Large-Language-Models-for-Automated-Web-Form-Test-Generation-An-Empirical-Study); [RCR report](https://research.nottingham.edu.cn/en/publications/large-language-models-for-automated-web-form-test-generation-an-e-2/) [peer-reviewed]
- **QTypist (Liu, Chen, Wang et al.; ICSE 2023, Android)**
  - Prompt context comes from the activity name, app name and nearby input widgets, rendered through linguistic patterns, and the model is prompt-tuned.
  - 87% passing rate on 106 apps (+93% over the best baseline). Combined with GUI testing tools it reached +42% activities and +52% pages.
  - A follow-up study of 9 LLMs confirms that more complete UI context raises pass-through rates.
  - Sources: [arXiv 2212.04732](https://arxiv.org/pdf/2212.04732); [ICSE 2023 page](https://conf.researchr.org/details/icse-2023/icse-2023-technical-track/151/Fill-in-the-Blank-Context-aware-Automated-Text-Input-Generation-for-Mobile-GUI-Testi); [arXiv 2404.08948](https://www.arxiv.org/pdf/2404.08948) [peer-reviewed + preprint]
- The **STG paper** handles conditional, dynamic forms with a dedicated form state graph and generates Selenium scripts. — [arXiv 2506.02529v2](https://arxiv.org/html/2506.02529v2) [preprint]
- A 2025 paper on fine-tuning LLMs for Selenium form interaction notes that "no public benchmark or dataset exists to evaluate LLMs on form interaction generation systematically". — [arXiv 2511.15168](https://arxiv.org/html/2511.15168v1) [preprint]
- LLM-Explorer used an LLM only for text-input generation within an otherwise non-LLM explorer, observing that LLMs produce human-like usernames, phones and emails. — [arXiv 2505.10593](https://arxiv.org/pdf/2505.10593) [preprint]
- Crawljax and ZAP fall back to **random values** in forms (`FormFillMode.RANDOM`; ZAP "Use Random Values in Form Fields"). — [CrawlRules.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/configuration/CrawlRules.java); [ZAP AJAX Spider options](https://www.zaproxy.org/docs/desktop/addons/ajax-spider/options/)

### Inferences
- The structural-first version for our pipeline is:
  - (1) derive hard constraints deterministically from HTML: `type`, `required`, `pattern`, `min`, `max`, `maxlength`, `step`, `<select>` options, `aria-invalid`;
  - (2) have the LLM propose only the *semantic* value per label, as in QTypist and FormNexus;
  - (3) validate the proposal against (1) in code before typing;
  - (4) after submit, read validation feedback structurally (`aria-invalid="true"`, `role="alert"`, `:invalid` pseudo-class, an unchanged screen fingerprint) and re-prompt once with the messages. This is FormNexus's feedback-refinement loop, bounded.
- "Submitted successfully" can be judged structurally, as a screen-fingerprint change or a new screen-map edge, rather than from success-message text.

### Gaps
- I could not find FormNexus's exact refinement-loop iteration count, or its per-field prompt template.

---

## 7. Open-source tools worth reusing: what each offers for discovery and exploration

### Takeaway
None of the agent frameworks (browser-use, Stagehand, Skyvern, Playwright MCP) is a **systematic crawler**. They are goal-directed agents. Their reusable parts are **page serialisation and interactive-element detection** (browser-use), **snapshot refs and locator generation** (Playwright MCP), and **observe/act caching with self-healing** (Stagehand). Crawljax remains the only mature open-source **state-flow-graph crawler**, with pluggable DOM, visual and fragment abstractions, but it is Java/Selenium.

### Cited Findings
- **Crawljax** [repo + source code]:
  - It produces a state-flow graph, offers 10 oracle comparators, and has state abstractions for DOM (Levenshtein, RTED/APTED, TLSH), visual (PDiff, SIFT, SSIM, ColorHistogram, image hashes) and hybrid.
  - The FragGen-style options are `crawlNearDuplicates`, `delayNearDuplicateCrawling`, `skipExploredActions` with `maxRepeatExploredActions = 2`, and `usefulFragmentRules`.
  - Other features are click rules, form fill modes and backtracking options.
  - Sources: [README](https://github.com/crawljax/crawljax); [CrawlRules.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/configuration/CrawlRules.java); [stateabstractions/dom](https://github.com/crawljax/crawljax/tree/master/core/src/main/java/com/crawljax/stateabstractions/dom); [stateabstractions/visual](https://github.com/crawljax/crawljax/tree/master/core/src/main/java/com/crawljax/stateabstractions/visual)
- **browser-use** [source code + README]: the interactive-element detector `is_interactive` returns on the first matching rule, in this order:
  - (1) reject non-elements, `html` and `body`;
  - (2) **JS click listener detected via CDP** (covers React, Vue and Angular handlers);
  - (3) iframes larger than 100×100 px;
  - (4) a label or span wrapping an input, select or textarea within 2 levels (but not a `label[for]`);
  - (5) search-indicator class or id substrings;
  - (6) AX properties: `disabled` or `hidden` → false; `focusable`, `editable` or `settable` → true; presence of `checked`, `expanded`, `pressed` or `selected` → true;
  - (7) tags `button, input, select, textarea, a, details, summary, option, optgroup`;
  - (8) attributes `onclick, onmousedown, onmouseup, onkeydown, onkeyup, tabindex`;
  - (9) ARIA roles including `button, link, menuitem, option, radio, checkbox, tab, textbox, combobox, slider, spinbutton, search, searchbox, row, cell, gridcell` (plus `listbox` from the AX tree);
  - (10) icon-sized elements of 10-50 px with class, role, onclick, data-action or aria-label;
  - (11) `cursor: pointer` as a fallback.
  - The serializer also includes `paint_order.py`.
  - Sources: [clickable_elements.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/serializer/clickable_elements.py); [serializer dir](https://github.com/browser-use/browser-use/tree/main/browser_use/dom/serializer)
  - The README reports a vendor-run "Stealth Bench V2" (90.5% of 100 bot-protected sites, Sep 2026) but no WebVoyager number. — [browser-use README](https://github.com/browser-use/browser-use) [repo/README, vendor-reported]
- **Stagehand** offers the `act` / `extract` / `observe` primitives; `observe` returns real selectors; it does hybrid accessibility-tree trimming, server-side action caching and self-healing; it is MIT-licensed, with TypeScript, Python and Go SDKs and v4 docs. — [stagehand README](https://github.com/browserbase/stagehand) [repo/README]
- **Playwright MCP** provides accessibility snapshots with element refs, `browser_fill_form`, `browser_generate_locator`, `browser_verify_*`, codegen to TypeScript, origin allow and block lists (not a security boundary), and isolated or storage-state contexts. — [playwright-mcp README](https://github.com/microsoft/playwright-mcp) [repo/README]
- **Skyvern**
  - It is driven by vision LLMs with a "swarm of agents" that plans and executes, and uses no predetermined XPaths.
  - It fills forms natively from `navigation_goal` data, and its workflows have blocks: task, action, extraction, validation, loops and others.
  - There is an "AI fallback" mode in which a click "tries selector first, falls back to AI if it fails".
  - It claims 64.4% on WebBench ("best on WRITE tasks"), and a linked report slug mentions 85.8% on WebVoyager (not stated in the body).
  - Source: [Skyvern README](https://github.com/Skyvern-AI/skyvern) [repo/README, vendor-reported]
- **Healenium** offers self-healing locators with `recovery-tries` and `score-cap` (example 0.5), plus an IDE plugin to write healed locators back into code. — [healenium-web README](https://github.com/healenium/healenium-web) [repo/README]
- **DroidAgent** (Android) is open source with a modified DroidBot submodule and produces UIAutomator2 scripts. — [coinse/droidagent](https://github.com/coinse/droidagent) [repo]
- **SoK Krawlers' Arachnarium** is open source per its artifact appendix and reimplements a decade of crawling strategies. — [USENIX page](https://www.usenix.org/conference/usenixsecurity24/presentation/stafeev) [peer-reviewed]

### Inferences
- Of these, **browser-use's interactive-element heuristic list** is the most directly portable to our live DOM walker for finding buttons that navigate without `<a href>`. The CDP JS-listener check (`DOMDebugger.getEventListeners`) is the decisive signal for React-style `div onClick` controls, which cheerio can never see.
- **Playwright MCP's ref-based snapshot** is the closest open design to our grounding. Since we already run Playwright, adopting the accessibility snapshot format (`page.accessibility` / `ariaSnapshot`) as the LLM-facing view is low-cost.
- **Stagehand's and Skyvern's "selector first, AI fallback, cache the healed result"** matches our "LLM proposes, code verifies" rule, provided the fallback result goes back through the deterministic grounding and the human-approval path (CLAUDE.md rule 6), not straight into the saved test.

### Gaps
- I could not read Stagehand's caching internals, Healenium's matching algorithm (both READMEs omit them), or browser-use's `allowed_domains` / `sensitive_data` handling, which is not in the README. The web-search budget ran out before targeted searches could be made.

---

## Adoptable techniques for our pipeline

### Takeaway
Six concrete, deterministic-first changes follow from the literature:
- (T1) a tiered state-equivalence rule with best-match merging and asymmetric containment;
- (T2) fragment-aware screen identity;
- (T3) a Crawljax/FragGen-style button-driven exploration loop with novelty priority and click-once;
- (T4) a structural safety policy enforced at the network layer;
- (T5) closed-set LLM grounding with deterministic candidate ranking and graph-derived prefixes;
- (T6) a bounded form-constraint feedback loop.

Each keeps the LLM in "propose" and code in "decide".

### Cited Findings (each technique with its sources)

**T1. Tiered state equivalence: clone, near-duplicate, distinct (replaces the single 0.7 rule).**
1. *Normalise first.* Before fingerprinting, drop volatile content: dates and times, counters, ad and promo regions, row data in lists and tables, and IDs and attributes that change per render. This follows Crawljax's comparator pipeline (`DateComparator`, `AttributeComparator`, `StyleComparator`, `RegexComparator`). — [Crawljax comparators](https://github.com/crawljax/crawljax/tree/master/core/src/main/java/com/crawljax/oraclecomparator/comparators); [Roest et al. via arXiv 2001.01128](https://arxiv.org/pdf/2001.01128)
2. *Clone:* the hash of the normalised (role, name) skeleton of interactive elements is equal. Treat it as the same screen and do not re-explore. — Yandrapally's three-class model, [ICSE 2020](https://conf.researchr.org/details/icse-2020/icse-2020-papers/102/Near-Duplicate-Detection-in-Web-App-Model-Inference)
3. *Near-duplicate vs distinct*, with the title/tab gate kept:
   - Use **Jaccard** `|A∩B|/|A∪B|` in addition to the overlap coefficient, so that a strict superset (a wizard step that adds fields) does not count as the same screen.
   - Suggested rule: same screen if `overlap >= 0.7 AND jaccard >= 0.5`, or if the controls (buttons) are also equal. Calibrate these thresholds on labelled pairs from our own `runs/`, as Yandrapally et al. computed thresholds per technique from labelled data.
   - The specific numbers here are my proposal, not from a paper. — method: [ICSE 2020](https://dl.acm.org/doi/abs/10.1145/3377811.3380416); per-app calibration slider: [TU Delft thesis](https://repository.tudelft.nl/file/File_2e95e62f-b3f6-4e94-b735-7dfed8947bac?preview=1)
4. *Best match, not first match.* Compare a new capture against **all** stored screens for the URL and merge into the highest-similarity one above threshold. This avoids the non-transitivity and order-dependence that Crawljax had to fix. — [arXiv 1405.0749](https://arxiv.org/pdf/1405.0749); [arXiv 2001.01128](https://arxiv.org/pdf/2001.01128)
5. *Near-duplicates are explored but delayed*, not discarded. This mirrors Crawljax defaults `crawlNearDuplicates = true` and `delayNearDuplicateCrawling = true`. — [CrawlRules.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/configuration/CrawlRules.java)
6. *Scale-out path, only if needed:* MinHash/TLSH over the skeleton string for candidate retrieval when the persistent map grows past its 60-screen cap. — [arXiv 2001.01128](https://arxiv.org/pdf/2001.01128); [Crawljax TLSH abstraction](https://github.com/crawljax/crawljax/tree/master/core/src/main/java/com/crawljax/stateabstractions/dom)

**T2. Fragment-aware screen identity (FragGen-lite).**
- Partition each screen into fragments by structural landmarks we already capture: `dialog`, `main` / `form` regions, `table` / `list` (data region), `tablist`, and header/nav/footer (chrome).
- Compare fragment by fragment. A screen is "same" when its **primary fragment** (the open dialog, else the main form) is a clone or near-duplicate. Data-region fragments compare by **structure only** (columns, row template), never by row content.
- Actionable identity is `(fragment-class, relative path or role+name within fragment)`. An action on a chrome fragment (such as a nav link) is the same action on every screen. — [FragGen, arXiv 2110.14043](https://arxiv.org/abs/2110.14043v1); [Crawljax fragmentation package](https://github.com/crawljax/crawljax/tree/master/core/src/main/java/com/crawljax/fragmentation); "compact abstractions" finding: [arXiv 2606.16650](https://arxiv.org/pdf/2606.16650)

**T3. Exploration loop for button-driven SPAs (closes task "C: discovery clicks buttons that navigate").**
```
frontier := priority queue of (screenKey, action) ; visitedActions := {} ; budget := {maxStates, maxDepth, maxRuntime, maxActionsPerScreen}
on capture(screen S):
  key := tieredMatch(S)                          # T1/T2
  for a in interactive(S):                       # browser-use heuristics + CDP click-listener check
    if blocked(a) continue                       # T4 deterministic policy
    id := actionableId(a)                        # T2 fragment-relative identity
    if id in visitedActions and repeats(id) >= 2 continue    # Crawljax skipExploredActions, maxRepeat=2
    prio := novelty(target_guess(a)) + rand_tiebreak         # curiosity: 1/sqrt(1+visits) within run AND in screen map
    if near_duplicate(key) prio -= delay                     # delayNearDuplicateCrawling
    push(frontier, (key, a, prio))
loop until budget exhausted:
  (key, a) := pop(frontier)
  if screenMap has deterministic edge (key,a)->T seen >= k times: record edge, skip execution   # SIBILLA memoisation
  restore(key): stay on SAME page; replay recorded action path from the entry URL (sessionStorage survives only in-tab)
  click(a); settle-wait; S' := capture(); record edge key -a-> key(S'); deprioritise all equivalents of a   # FragGen
```
Each piece and its source:
- Crawljax-style defaults: click-once, `maxRepeatExploredActions = 2`, depth, state and runtime caps with a 1-hour runtime default. — [CrawlRules.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/configuration/CrawlRules.java); [CrawljaxConfiguration.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/configuration/CrawljaxConfiguration.java)
- FragGen's deprioritisation of equivalent actionables. — [arXiv 2110.14043](https://arxiv.org/pdf/2110.14043)
- WebRLED's within-episode plus global novelty, here without RL. — [arXiv 2504.19237](https://arxiv.org/html/2504.19237v1)
- The randomised tie-break, because randomised crawlers beat common ones on coverage. — [SoK Krawlers](https://www.usenix.org/conference/usenixsecurity24/presentation/stafeev)
- SIBILLA memoisation of deterministic transitions. — [Guess the State](https://boa.unimib.it/handle/10281/462218)
- The browser-use interactive heuristics. — [clickable_elements.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/serializer/clickable_elements.py)
- LLM use in the loop is limited to (a) text inputs (T6) and (b) an optional periodic summarisation of screens into **functionality-level** labels for the screen-map hints, not per-click decisions. — [LLM-Explorer](https://arxiv.org/pdf/2505.10593); [AutoDroid memory injection](https://arxiv.org/pdf/2308.15272); [arXiv 2606.16650](https://arxiv.org/pdf/2606.16650)

**T4. Deterministic safety policy for exploration (never LLM-judged).**
- Evidence that the LLM cannot be trusted with this: frontier LLMs fall below 60% on HIGH-risk recall, and a base 7B model reaches 20%. — [WebGuard](https://arxiv.org/pdf/2507.14293)
- Policy, in order of strength:
  - (1) **Network guard during discovery.** `page.route('**', ...)` aborts any non-GET request (POST, PUT, PATCH, DELETE) and form submission except an allowlisted auth endpoint and explicitly opted-in forms. Mutations then cannot happen even if a click is misclassified. Playwright's routing is the same capability Playwright MCP exposes under `--caps=network`. — [playwright-mcp README](https://github.com/microsoft/playwright-mcp)
  - (2) **Structural deny rules:** `type=submit` inside a form with a non-GET method; buttons inside `dialog`/`alertdialog` that confirm; `input[type=file]`; elements outside the crawl scope; external origins (`followExternalLinks = false`). — [CrawlRules.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/configuration/CrawlRules.java)
  - (3) **Name-based deny list** (delete, remove, pay, purchase, checkout, place order, sign out, deactivate, transfer, publish) as an *extra* signal only. Crawljax's `dontClick` is the precedent. — [CrawlRules.java](https://github.com/crawljax/crawljax/blob/master/core/src/main/java/com/crawljax/core/configuration/CrawlRules.java)
  - (4) An isolated context per discovery walk. Origin allowlists alone are not a security boundary. — [playwright-mcp README](https://github.com/microsoft/playwright-mcp)
- Report coverage *under policy* (screens reached with zero blocked mutations, plus the count of blocked actions), following ST-WebAgentBench's CuP framing. — [ST-WebAgentBench](https://arxiv.org/html/2410.06703v4)

**T5. LLM grounding patterns for test-step generation.**
1. *Closed-set targets with stable ids.* Give the model a per-screen candidate list with ids, as in Playwright MCP refs or Stagehand `observe`, and require it to pick an id or answer "NONE". The existing `groundingError()` check stays as the backstop. — [playwright-mcp](https://github.com/microsoft/playwright-mcp); [stagehand](https://github.com/browserbase/stagehand)
2. *Deterministic pre-ranking, MindAct-style.* Rank candidates by role match, name token similarity to the step intent, and same-screen membership. Pass the top-k (k≈10-20, where community rankers reach about 93% recall@10) as multiple choice with a "None" option. — [Mind2Web, arXiv 2306.06070](https://arxiv.org/pdf/2306.06070); [CVPR 2024 supplement](https://openaccess.thecvf.com/content/CVPR2024/supplemental/Kil_Dual-View_Visual_Contextualization_CVPR_2024_supplemental.pdf); [HF ranker card](https://huggingface.co/torontodeveloper/mind2web-candidate-ranker)
3. *Graph-derived navigation prefix.* For a case whose target screen is in the screen map, compute the shortest path (Dijkstra/BFS over edges, weighted by `1/seen`) from the entry screen. Emit those steps deterministically, and have the LLM write only the case-specific steps. — [STG paper, arXiv 2506.02529](https://arxiv.org/html/2506.02529v2)
4. *Symbolised assertions.* Assertions reference discovered element ids or symbols, not free text. — [WebTestPilot](https://arxiv.org/html/2602.11724v1)
5. *Consistency gate.* Run a newly generated test N times (for example 3) before reporting a failure as an app bug, and flag nondeterministic verdicts as test or environment issues. — [Salva & Taguelmimt, ENASE 2026](https://arxiv.org/html/2509.19136v2)
6. *Context shaping.* Give the LLM functionality-level screen summaries or component abstractions, not raw DOM or full graph dumps. — [arXiv 2606.16650](https://arxiv.org/pdf/2606.16650); [VISCA](https://arxiv.org/abs/2506.04161v1); [web-form study, PH-P pruning](https://arxiv.org/pdf/2405.09965)

**T6. Form filling with a bounded validation-feedback loop.**
1. Extract hard constraints deterministically: `type`, `required`, `pattern`, `min`, `max`, `maxlength`, `step`, `select` options and `aria-*`.
2. The LLM proposes a semantic value per labelled field, with full form context (all labels, help text, section headings). — [QTypist](https://arxiv.org/pdf/2212.04732); [web-form study](https://arxiv.org/pdf/2405.09965)
3. Validate the proposals in code against step 1.
4. Submit (only where T4 allows, e.g. on a sandbox tenant). Detect failure structurally: `aria-invalid`, `role=alert`, `:invalid`, or an unchanged screen fingerprint. Re-prompt once with the validation messages, which is FormNexus's feedback refinement. — [FormNexus](https://arxiv.org/html/2402.00950v2)
5. Record a successful submission as a screen-map edge, so later runs reuse it (memoisation, T3).

### Inferences
- T1 (best-match merge plus a Jaccard guard), T3 and T4(1) are the highest-value, lowest-risk items for the stated SPA under-discovery problem. All three are pure code, which fits CLAUDE.md's "deterministic check behind every LLM preference" rule and its flag-off-by-default rule.
- T5(1-2) change the shape of the prompt and IR request. Per the platform rules, that should ship behind a new env flag, with cache keys that include the new prompt dimension (TD-22, D-10).
- The 0.7, 0.5 and k values above are starting points to calibrate offline against saved `runs/<id>/02-appmodel.json` captures (artifact replay). They are not values from any paper. Yandrapally et al.'s central lesson is that such thresholds are app-dependent.

### Gaps
- No paper found evaluates these techniques **combined** on enterprise SPAs such as Salesforce-style apps. Expected gains are extrapolated from per-technique results on open-source CRUD apps (Yandrapally/FragGen subjects), Android (LLM-Explorer, AutoDroid, DroidAgent) or benchmark sites (WebArena, Mind2Web).
- The search budget (shared across agents) ran out before follow-ups on browser-use's `allowed_domains` / `sensitive_data`, Stagehand's cache internals, Healenium's algorithm, and the Yandrapally threshold tables. A follow-up session with fresh search budget, or access to arxiv.org or ubc.ca, could fill these.
