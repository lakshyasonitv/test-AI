# Salesforce-specialist test-automation tools: how they handle Lightning, LWC and Experience Cloud UIs

Research date: 2026-10-15. Scope: Provar (Automation, NitroX), Copado Robotic Testing (QWeb/QWords), Salesforce UTAM, Tricentis Tosca and Testim for Salesforce, Keysight Eggplant, and Salesforce's own guidance.

**Source labels used on every claim:**
- **[Official]**: Salesforce documentation, or the vendor's product documentation.
- **[Vendor-mkt]**: a vendor's marketing page or blog. Biased: treat it as a claim, not proof.
- **[Primary-code]**: published source code or packages that I downloaded and read in this session:
  - `salesforce-pageobjects@12.0.0` from npm;
  - `QWeb==3.8.3` from PyPI;
  - `salesforce-utam@0.1.1` from npm.
- **[Third-party]**: an independent or community source.

**How the research was done, and its limits:**
- WebFetch failed with DNS errors for `utam.dev`, `developer.salesforce.com` and `docs.tricentis.com`, and curl to `documentation.provar.com` was refused by the proxy.
- `registry.npmjs.org`, `pypi.org` and `raw.githubusercontent.com` were reachable, so the strongest evidence below comes from reading Salesforce's and Copado's published code directly.
- The shared WebSearch budget ran out partway through the work. As a result, the following were not researched further:
  - Copado's closed Salesforce keyword library and its AI features;
  - Keysight Eggplant;
  - Lightning Web Security and Locker;
  - synthetic versus native shadow DOM.

These are recorded as Gaps below.

---

## 1. Provar (Provar Automation, NitroX): metadata-driven locators, page objects, LWC and Experience Cloud, data, releases

### Takeaway
Provar's core idea is to bind test steps to Salesforce **metadata**: object and field API names pulled from a live org connection, plus page layouts. It does not bind to DOM paths. Provar's own engine resolves that metadata to the current DOM, so a Salesforce DOM change is absorbed by a Provar release rather than by every customer's tests.

For anything that is not a standard Salesforce field it falls back to:
- an SLDS-label locator;
- Java page objects (`@FindBy`);
- NitroX, which builds shadow-DOM-aware component models for LWC.

Its Experience Cloud support is weaker and was opt-in as of 2025.

### Cited Findings
- **[Vendor-mkt]** Provar says it locates components through Salesforce metadata identifiers and API names, not CSS classes or XPaths. — [Provar blog: Salesforce Metadata-Aware Test Automation Features](https://provar.com/blog/product/provar-automations-most-relevant-features-salesforce-metadata-aware-authoring/)
- **[Official]** "Reload Org Cache" connects to the Salesforce org, checks for updated or changed metadata files, and downloads them for test cases. It offers three options: Reconnect, Refresh Only Changed Files, and Refresh All Files. This means Provar keeps a **local cache of org metadata**, and that cache is what tests are authored against. — [Provar docs: Reload Org Cache](https://documentation.provar.com/documentation/reload-org-cache/)
- **[Official]** An "Extract Salesforce Layout" API extracts a page layout and its field details from a connected org, for example the Contact object. It can optionally include permission-set details in the field list. — [Provar docs: Extract Salesforce Layout](https://documentation.provar.com/?p=1244)
- **[Official]** Provar's test-design guidance:
  - do not use Salesforce record IDs as field locators;
  - use the metadata integration instead.
  — [Provar docs: Test Case Design](https://documentation.provar.com/documentation/recommended-practices/testing-best-practices/test-case-design/)
- **[Official]** UI fields map the same way in Lightning and Classic, so a test built in one can run in the other. — [Provar docs: Salesforce Lightning Testing](https://documentation.provar.com/documentation/salesforce-testing/salesforce-lightning-testing/)
- **[Official]** Provar added a **"By SLDS Label"** locator for fields on pages built to the Salesforce Lightning Design System (SLDS).
  - The Test Builder suggests it when you map those fields.
  - It works in both read and edit mode.
  - No page object is needed.
  — [Provar docs: Salesforce Lightning Testing](https://documentation.provar.com/documentation/salesforce-testing/salesforce-lightning-testing/); [Provar docs: Visualforce Testing](https://documentation.provar.com/documentation/salesforce-testing/visualforce-testing/)
- **[Official]** For non-Salesforce or non-standard fields:
  - a Label locator finds the field by the label immediately before it;
  - Provar recommends a page object for these cases;
  - the Name, ID or XPath locators are the alternatives.
  — [Provar docs: Mapping Non-Salesforce Fields](https://documentation.provar.com/documentation/v3/automation-mapping-non-salesforce-fields/)
- **[Official]** Page objects are Java files listing field names and locators for one Visualforce or non-Salesforce page.
  - Locators use Selenium `@FindBy` (xpath, id, name, css, label…), wrapped in interaction-type annotations such as `@TextType()`, `@ButtonType()` and `@LinkType()`.
  - Tables use `@PageTable` and `@PageRow`, with `@VisualforceBy(componentXPath=...)`.
  — [Provar docs: Using Java Method Annotations](https://documentation.provar.com/documentation/page-objects/using-java-method-annotations/); [Provar docs: Visualforce Testing](https://documentation.provar.com/documentation/salesforce-testing/visualforce-testing/)
- **[Official]** LWC: shadow DOM encapsulation means XPath and CSS locators often cannot reach elements inside components. NitroX generates "Shadow DOM-compliant" locators that can set, read and assert values, and "automatically interprets the page structure and generates a unique locator path." — [Provar docs: LWC Locator Support](https://documentation.provar.com/documentation/salesforce-testing/salesforce-lightning-web-component-lwc-locator-support/)
- **[Official]** NitroX "Adaptive Locators" capture numerous attributes of a web element to find it again. They can be switched off in favour of an explicit locator defined in ProvarX. — [Provar docs: The NitroX User Interface](https://documentation.provar.com/documentation/the-nitrox-user-interface/)
- **[Official]** Experience Cloud, two sources:
  - The NitroX supported-components page lists OmniStudio and Experience Cloud as future goals. — [Provar docs: NitroX Supported Components](https://documentation.provar.com/documentation/v3/automation-nitrox-supported-components)
  - The Spring '25 Release 1 notes (v2.15.1.2) say NitroX component mapping is **not on by default for generic web pages, including Experience Cloud**; components can be built on request. — [Provar docs: Spring '25 release notes](https://documentation.provar.com/?p=35523)
- **[Vendor-mkt]** Provar's Winter '26 post warns that scripts which depend on old field *labels* can break across a release, and that label-based assertions need updating. — [Provar blog: Winter '26 Testing Insights](https://provar.com/blog/product/navigating-salesforce-winter-26-release-what-testers-and-automation-teams-need-to-know/)
- **[Official]** Test data via the API, from the org Explorer:
  - **Create** step: drag an object onto the test case; the created record's ID goes into a "Result Object Id" variable.
  - **Delete** step: deletes at API level.
  - **SOQL** step: queries records.
  - **Apex Bulk** step: supports Delete and Hard Delete. Hard Delete needs the Bulk API Hard Delete permission.
  - **Teardown test cases** run at the end of a test folder's run to delete the data that run created; the example uses SOQL to get the ID, then Delete.
  - A "Log For Cleanup" step is listed in the palette, but its documentation was "coming soon".
  — [Provar docs: Salesforce API Testing](https://documentation.provar.com/documentation/v3/automation-salesforce-api-testing/); [Create Records via API](https://documentation.provar.com/documentation/v3/automation-create-records-via-api/); [Setup and Teardown Test Cases](https://documentation.provar.com/documentation/support/setup-and-teardown-test-cases); [Apex Bulk](https://documentation.provar.com/documentation/using-the-test-palette/salesforce/apex-bulk/); [Test Palette Introduction](https://documentation.provar.com/documentation/using-the-test-palette/test-palette-introduction/)

### Inferences
- Provar's resilience across releases comes from **indirection**. The test stores "Object.Field + action"; the DOM-to-metadata mapping lives in Provar's runtime and is updated by Provar each Salesforce release. Our equivalent would be to ground steps against a field *API name* where one can be discovered, and treat the DOM locator as a derived, regenerable artifact.
- The SLDS-label locator is close to our label-anchored selector. Provar's choice to make it the default suggestion for SLDS pages supports our current direction for Lightning pages.
- The metadata cache has to be refreshed. This mirrors our own lesson that a cache key missing a real input dimension serves stale answers; org metadata is such a dimension.

### Gaps
- No Provar documentation was found on its internal locator URI scheme (for example, how a UI step stores object and field), or on exactly how a field API name is mapped to a DOM node at runtime. A WebSearch for the commonly cited `sf:ui:binding` syntax returned nothing relevant, and GitHub code search was unavailable in this session.
- Provar handling of picklists, lookups, related lists, list views, modals and Setup iframes was not found in the documentation snippets retrieved.
- No independent (non-Provar) evaluation of Provar's resilience across releases was found.

---

## 2. Copado Robotic Testing (formerly Qentinel Pace; QWords on Robot Framework): text-based location, waits, AI

### Takeaway
Copado Robotic Testing (CRT) locates elements by **visible text**, using QWords such as `ClickText`, `TypeText` and `VerifyText`. Its open-source engine, **QWeb**, does the work.

Reading QWeb 3.8.3 shows concrete, adoptable mechanisms:
- a multi-signal "enhanced" readiness wait: readyState, then fetch/XHR idle **excluding Salesforce CometD long-polling**, then visible-spinner probe, then a bounded DOM-quiet window;
- label-to-input resolution through `label[for]`, then ancestor traversal;
- anchor-relative search;
- a modal-scope XPath;
- opt-in shadow-DOM search;
- special handling for text that Salesforce places directly in `<slot>`s.

### Cited Findings
- **[Official]** Salesforce Trailhead defines QWords as keywords pulled from the underlying code to give test cases readability, usability, maintainability and robustness:
  - `ClickText`: click text (a button, link and so on) on a screen;
  - `TypeText`: write to an input field;
  - `VerifyText`: verify that text appears on screen.
  Tests are written in QEditor, or produced by live testing and UI recording. — [Trailhead: Automate Tests with Copado Robotic Testing](https://trailhead.salesforce.com/content/learn/modules/copado-robotic-testing-for-salesforce/automate-tests-with-copado-robotic-testing)
- **[Vendor-mkt]** QWords "follow natural language patterns" and are usable by admins without a testing background. — [Copado ebook](https://copado.com/devops-hub/ebooks/copado-robotic-testing-cloud-native-test-suites-2)
- **[Primary-code]** QWeb is open source (Apache-2.0, "Copyright © 2014 - Qentinel Group"). The latest PyPI release is 3.8.3, uploaded 2026-09-28. — [PyPI: QWeb](https://pypi.org/project/QWeb/); [GitHub: qentinelqi/qweb](https://github.com/qentinelqi/qweb)
- **[Primary-code] Enhanced wait, the default `WaitStrategy`.** `wait_xhr()` runs these checks in order:
  1. `document.readyState === "complete"`;
  2. network idle;
  3. no visible spinner (only if `SpinnerCSS` is configured);
  4. DOM quiet for `RenderWait`. The default is 200 ms, capped at `min(1.5 × RenderWait, 1500 ms)`, after which it "accept[s] minor DOM churn and proceed[s]".

  `XHRTimeout` defaults to 30 s, and on timeout the wait *continues rather than fails*. The documentation names Salesforce Lightning as the target for this mode. — [QWeb/internal/xhr.py](https://github.com/qentinelqi/qweb/blob/master/QWeb/internal/xhr.py), [QWeb/keywords/config.py](https://github.com/qentinelqi/qweb/blob/master/QWeb/keywords/config.py), [QWeb/internal/config_defaults.py](https://github.com/qentinelqi/qweb/blob/master/QWeb/internal/config_defaults.py)
- **[Primary-code] How network idle is measured.** An injected monitor (`install_monitor.js`):
  - patches `window.fetch` and `XMLHttpRequest.prototype.open/send` to keep a `pending` counter;
  - uses a MutationObserver for the last-mutation timestamp;
  - **does not count XHRs whose body contains `"connectionType":"long-polling"`**. That is the Bayeux/CometD long-poll Salesforce uses for streaming, which would otherwise keep "network idle" false forever.

  It is idempotent (`window.__xhrMon.installed`). — [QWeb/internal/js/install_monitor.js](https://github.com/qentinelqi/qweb/blob/master/QWeb/internal/js/install_monitor.js)
- **[Primary-code] Spinner probe (`spinner_busy.js`).** For each matching selector it:
  - finds the *deepest descendant that actually paints*, walking into `shadowRoot`s: not `display:none`, `visibility:hidden` or `opacity:0`, with non-zero size, and at least 4 px² inside the viewport;
  - then checks the spinner is **topmost** at three sample points: centre and two corners.

  The documented Salesforce example is: `SetConfig SpinnerCSS lightning-spinner,.slds-spinner:not(.slds-hide),[aria-busy="true"]`. — [QWeb/internal/js/spinner_busy.js](https://github.com/qentinelqi/qweb/blob/master/QWeb/internal/js/spinner_busy.js); [config.py SpinnerCSS docs](https://github.com/qentinelqi/qweb/blob/master/QWeb/keywords/config.py)
- **[Primary-code] Label to input resolution (`get_by_label.js`).** For each `<label>`:
  - If it has a `for` attribute and its innerText equals the locator, match the input whose **`id` *or* `name`** equals the `for` value.
  - Otherwise walk up to N ancestor levels and take the first matching input. The `TypeText` docs mention up to the fifth parent.

  Results are ranked full match, then partial match with `for`, then partial match. — [QWeb/internal/js/get_by_label.js](https://github.com/qentinelqi/qweb/blob/master/QWeb/internal/js/get_by_label.js)
- **[Primary-code]** Fallback input matching uses the XPath `//*[(self::input or self::textarea) and (normalize-space(@placeholder)="{0}" or normalize-space(@value)="{0}")]`. — [QWeb/internal/search_strategy.py](https://github.com/qentinelqi/qweb/blob/master/QWeb/internal/search_strategy.py)
- **[Primary-code]** Disambiguation and scoping settings:
  - `SearchDirection` defaults to `closest` relative to an **anchor** (text or index). It also accepts `up/down/left/right`, and `!` makes the direction strict.
  - `IsModalXpath`: when set to something other than `//body`, text search considers **only elements under that XPath while it exists**. It is documented "for applications that have modal dialogs but do not set elements below the dialog hidden."
  - `ShadowDOM` is **off by default** and turned on per section with `SetConfig ShadowDOM True`; the search then walks open shadow roots using JS walkers such as `get_clickable_from_shadow_dom.js`.
  — [config.py](https://github.com/qentinelqi/qweb/blob/master/QWeb/keywords/config.py); [QWeb/internal/js/](https://github.com/qentinelqi/qweb/tree/master/QWeb/internal/js)
- **[Primary-code]** `get_slot_elements()` exists because "some systems like Salesforce put texts directly in slots". Slot text has no layout offset, so the clickable target becomes the parent `<a>`. — [QWeb/internal/text.py](https://github.com/qentinelqi/qweb/blob/master/QWeb/internal/text.py)
- **[Primary-code]** QWeb itself contains no Salesforce-specific keywords; a grep for "salesforce", "lightning" and "slds" finds only the documentation lines above. The Salesforce-specific keywords live in Copado's separate library, which was not inspected. — [QWeb 3.8.3 sdist](https://pypi.org/project/QWeb/3.8.3/)

### Inferences
- CRT's resilience comes from **targeting by what a user sees**, using labels, anchors and visible text, plus a robust, generic readiness wait. It does not depend on Salesforce internals. This matches our role, accessible-name and label approach. The main pieces we lack are the network-idle signal with the long-poll exclusion, and the paint-and-topmost spinner test.
- `IsModalXpath` is the same idea as our dialog-first resolution (TD-72), which validates it.

### Gaps
- The search budget was exhausted before these could be researched:
  - Copado's Salesforce-specific keyword library (picklist, lookup, related-list and login keywords);
  - Copado AI test generation and agentic features, and self-healing claims, as of 2026.
- No independent evaluation of CRT's self-healing was found.

---

## 3. Salesforce UTAM (UI Test Automation Model): JSON page objects, shadow DOM, published Lightning page objects

### Takeaway
UTAM is Salesforce's official answer to Lightning's hidden identifiers.
- Page objects are declarative JSON that models shadow boundaries explicitly; it compiles to Java, JavaScript or TypeScript.
- Salesforce publishes and re-versions a large page-object library (`salesforce-pageobjects`) **per Salesforce release**: 1,638 `.utam.json` files in 12.0.0 (Spring '26).
- The official JavaScript runtime targets WebdriverIO. Playwright support exists only through a July 2026 community adapter.
- The page objects are the best public evidence of **which DOM hooks Salesforce itself treats as automation-stable**: see section 7.
- Experience Cloud coverage is thin.

### Cited Findings
- **[Official]** UTAM page objects are JSON, compiled to Java, JavaScript or TypeScript.
  - The grammar models a component's shadow DOM in a `shadow` object, and the compiler generates methods that cross the boundary.
  - The convention is `componentName.utam.json` in a `__utam__` folder beside the component.
  — [Salesforce: What Is UTAM?](https://developer.salesforce.com/docs/platform/utam/guide/what-is-utam.html); [Design Page Objects](https://developer.salesforce.com/docs/platform/utam/guide/page-objects.html)
- **[Official]** To find the right page object:
  - Aura components carry a `data-aura-class` attribute.
  - A Lightning web component always has a custom tag such as `lightning-input`, and the tag maps to the page-object class (`lightning-input` → `Input`).
  - A UTAM Chrome extension locates page objects on a live page.
  — [Salesforce: Find Salesforce Page Objects](https://developer.salesforce.com/docs/platform/utam/guide/find-sf-page-objects.html); [Salesforce Developers blog: UTAM Chrome extension (Jan 2024)](https://developer.salesforce.com/blogs/2024/01/build-end-to-end-tests-fast-with-the-utam-chrome-extension)
- **[Primary-code] Versioning per release.** The npm dist-tags show one major version per Salesforce release: `spring22: 1.0.2` … `spring24: 6.0.3`, `summer24: 7.0.1`, `spring25: 9.0.0`, `summer25: 10.0.2`, `latest/spring26: 12.0.0`.
  - 12.0.0 was published 2026-03-09.
  - The README says the package "is compatible with the Spring'26 Salesforce release" and with `wdio-utam-service` 3.0.0–3.3.0.
  - As of 2026-10-15 no Summer '26 or Winter '27 version had been published.
  — [npm: salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects)
- **[Primary-code]** Inside `salesforce-pageobjects@12.0.0`:
  - 1,638 `.utam.json` page objects;
  - 1,061 of them declare a `shadow` block;
  - 116 use `beforeLoad` waits;
  - only 8 declare `frame` elements.

  (My count from the package tarball; a secondary figure of "727 base page objects as of Winter '24" appeared in search results without clear attribution.) — [npm: salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects)
- **[Official]** Supported runtimes:
  - The UTAM JS recipes integrate the UTAM runtime with **WebdriverIO** (`wdio-utam-service`), log in through the standard login page, and are "compatible with the Salesforce Spring'26 release".
  - They also warn: "If your org has customizations, you might need to modify page objects or tests locally."
  - The Java runtime targets Java 11 and Maven.
  — [GitHub: salesforce/utam-js-recipes](https://github.com/salesforce/utam-js-recipes); [GitHub: salesforce/utam-java](https://github.com/salesforce/utam-java)
- **[Third-party] Playwright adapter.**
  - `playwright-utam@0.1.1` (created 2026-07-12, sole maintainer `danielwanja`, not Salesforce) implements `@utam/core`'s Driver and Element contracts over Playwright, so official page objects "work unchanged". Its finds are deliberately light-DOM-scoped because the page objects declare shadow boundaries themselves.
  - The companion `salesforce-utam@0.1.1` adds `sf` CLI auth, navigation, `waitForReady`, `waitForToast`, and SOQL/create/delete helpers.
  - Both are very new and community-maintained.
  — [npm: playwright-utam](https://www.npmjs.com/package/playwright-utam); [npm: salesforce-utam](https://www.npmjs.com/package/salesforce-utam)
- **[Primary-code] How Salesforce's own page objects drive key widgets.** All paths are inside `salesforce-pageobjects@12.0.0/dist/` ([npm](https://www.npmjs.com/package/salesforce-pageobjects)).
  - **Picklist and combobox** (`lightning/baseCombobox.utam.json`, `lightning/baseComboboxItem.utam.json`):
    - *Open and wait:* `expand` = click the root, then wait until `div.slds-dropdown_fluid` is visible. `waitForItemsToLoad` = wait until a `lightning-base-combobox-item` exists.
    - *Pick an option:* by **`data-value`** (`lightning-base-combobox-item[data-value='%s']`, the picklist API value), or by label text equal to `.slds-media__body` text. `clickItem` waits for present, then scrollToTop, then visible, then clicks.
    - *State checks:* disabled = trigger input class contains `slds-is-disabled`; read-only = `aria-readonly="true"`; selected value = trigger's `data-value`; checked = `aria-checked=true`.
  - **Picklist variants** (`lightning/picklist.utam.json`): a `lightning-picklist` can render as **`lightning-combobox`, `lightning-dual-listbox` (multi-select) or `lightning-select`**. A record-page picklist is `records-record-picklist` › `records-form-picklist` › base picklist.
  - **Lookup** (`lightning/lookupDesktop.utam.json`):
    1. focus the input, then `typeText`;
    2. `waitForSuggestions` (= base combobox `waitForItemsToLoad`);
    3. `selectRecordSuggestionByLabel` (exact label match);
    4. verify via `getSelectedRecordLabel` (the pill label).

    Special dropdown items are `data-value='actionAdvancedSearch'` and `'actionCreateNew'`. `waitUntilReady` waits until the lookup is **not disabled**.
  - **Record field** (`records/recordLayoutItem.utam.json`):
    - Label = the `field-label` attribute on the `records-record-layout-item` root.
    - "Gets the target field's API name" = `getAttribute('data-target-selection-name')` on the inner `[data-target-selection-name]` wrapper.
    - Inline edit = `button.inline-edit-trigger`, then wait for `[slot='inputField']`; output is `[slot='outputField']`.
    - Field sub-types are separate custom elements: `records-record-layout-lookup`, `records-record-picklist`, `records-record-layout-input-date-time`, `records-record-layout-checkbox`, `records-record-layout-input-address`, and so on.
  - **Text input** (`lightning/input.utam.json` + `inputUtils.utam.js`): `setText` = scrollToCenter, then click, then clear (Ctrl+A/Delete, then Cmd+A/Delete, then `clear()` fallback, each followed by a value re-check), then type. Errors are read from `.slds-form-element__help`.
  - **Compound fields:** name and address sub-inputs are addressed by `data-field`, for example `lightning-input[data-field='firstName']`, `lightning-picklist[data-field='salutation']`, `lightning-input[data-field='postalCode']`.
  - **Modal** (`lightning/modal.utam.json`): `lightning-modal` › `lightning-modal-header/body/footer`, close via `[data-close-button]`, label via `[data-modal]` `aria-label`.
  - **Readiness:**
    - Record home (`global/recordHomeTemplateDesktop.utam.json`): root `one-record-home-flexipage2`, with `beforeLoad` waiting until the root contains `.forcegenerated-flexipage-module`.
    - `records/lwcRecordLayout.utam.json`: has `waitForHighlights2`.
  - **Classic and Visualforce inside Lightning, including many Setup pages** (`force/alohaPage.utam.json`): `force-aloha-page` › frame `iframe[name^=vfFrameId]`. Other frames modelled: `iframe[name='surfaceFrame']` (builder canvases).
  - **Login** (`helpers/login.utam.json`): `div#content` › `input[type='email']`, `input[type='password']`, `input[type='submit']`.
  - **Dynamic Forms:** `flexipage/column2` exposes `flexipage-field[data-field-id='%s']`, but the generated code says this PO "is currently in development and will not be available to customers."
  - **Experience Cloud** has only a handful of page objects: `dxp_base` (languageSelector, textBlock), `dxp_form` (dxpInput, leadForm), `dxp_records` (detailPanel, section, sectionRow), and `community_layout` (column, section, sldsFlexibleLayout). A separate `communities-pageobjects@1.0.0` on npm dates from 2023-04-17 and has no README.
- **[Vendor-mkt]** Gearset's comparison, from a vendor of a competing tool: Selenium usually needs custom JS for shadow DOM, while Playwright handles shadow DOM natively. — [Gearset: UTAM vs third-party](https://gearset.com/blog/salesforce-ui-testing-tools/)

### Inferences
- UTAM's practical limits:
  - page objects describe *standard* components in a *generic* org, so customized orgs need local overrides (the recipes README says as much);
  - the official runtime is WebdriverIO and Java, not Playwright;
  - Experience Cloud and custom LWCs are largely uncovered;
  - each Salesforce release needs a new package version.
- For an LLM pipeline the most useful UTAM asset is the **data**, not the runtime. The JSON page objects encode, per Lightning component type, the interaction recipe (open, wait, pick, verify) and Salesforce-blessed hooks. They can be mined deterministically, with no LLM, into component-type-specific action recipes for our generator.
- `data-target-selection-name` is what Salesforce's own page object uses to get a field's API name. That makes it the strongest available signal for label-to-API-name mapping on record pages, though it is not in the public component reference.
- Not every `data-target-selection-name` value is an API name. `lists/listViewManagerButtonBar.utam.json` uses opaque hex values such as `7d985dc5145c4b87b9fb59d9a46fab85`, and buttons use `sfdc:StandardButton.<Object>.<Name>`.

### Gaps
- The exact value format of `data-target-selection-name` on record *fields* was not confirmed. It is commonly reported as `sfdc:RecordField.<Object>.<Field>`, but no source in this session showed it. Verify on a live org.
- The utam.dev grammar pages could not be fetched (DNS), so `beforeLoad`, `wait` and `filter` semantics are inferred from the compiled page objects only.

---

## 4. Tricentis Tosca (Salesforce Engine 3.0, Salesforce Scan) and Tricentis Testim Salesforce

### Takeaway
- **Tosca** is model-based. A "Salesforce Scan" connects to the org and auto-creates reusable Modules for every accessible control, and the engine detects Classic versus Lightning from the URL. Tosca's own documentation admits that customized layouts can yield non-unique modules, with XScan (generic scanning) as the fallback.
- **Testim** sells AI "smart locators" that filter dynamic ids and classes and walk shadow roots. Most of its Salesforce claims are marketing, but its official documentation gives a concrete data-cleanup convention.

### Cited Findings
- **[Official]** Tosca's Salesforce Scan "connects to your Salesforce instance and automatically creates Modules from all controls that can be accessed"; the Salesforce Scanner scans the whole instance in one click. — [Tricentis docs: Use the Salesforce Scan (2026.1)](https://docs.tricentis.com/tosca-2026.1/en-us/content/engines_3.0/salesforce/sfdc_sitescanner.htm)
- **[Official]** Salesforce Engine 3.0 identifies Classic versus Lightning Experience from the application URL. — [Tricentis docs: Salesforce Engine 3.0 (2026.1)](https://docs.tricentis.com/tosca-2026.1/en-us/content/engines_3.0/salesforce/sfdc_engine.htm)
- **[Official]** Scanning a **customized layout**, for example Related Record on a Details page, gives the Related Record "Container" property a custom value. Custom values do not uniquely identify controls, so Modules from that scan may fail at execution. The recommendation is to use XScan. — [Tricentis docs: Use the Salesforce Scan (16.0)](https://documentation.tricentis.com/tosca/1600/en/content/engines_3.0/salesforce/sfdc_sitescanner.htm)
- **[Vendor-mkt]** A Tricentis partner says Salesforce controls are all dynamic, finding stable locators takes substantial time, and Lightning hides identifiers on elements. — [SOAIS](https://soais.com/?p=1016663)
- **[Vendor-mkt]** Testim's claims about its Salesforce support:
  - it "maps and filters dynamic CSS names" and IDs to "focus on stable attributes";
  - its AI locators "automatically identify and lock in elements of default and custom objects";
  - it handles Lightning components behind `#shadow-root` by "navigating the shadow tree";
  - it does "early testing on upcoming Salesforce releases";
  - its tests "self-heal and continue to work across updates".
  — [Testim Salesforce](https://testim.io/salesforce); [Tricentis Testim Salesforce](https://tricentis.com/products/test-automation-salesforce); [Tricentis blog: Testim locator technologies](https://www.tricentis.com/blog/testim-locator-technologies)
- **[Official]** Testim's documented cleanup practice:
  - test records are named with a **fixed prefix plus a random suffix**;
  - an **Execute Apex** step finds them by prefix and deletes **children before parents**.
  — [Tricentis Testim docs: Variable naming convention for easy cleanup](https://docs.tricentis.com/testim/content/salesforce-testing/best-practice-variable-naming-convention-for-easy-cleanup.htm); [Testim Salesforce FAQ](https://docs.tricentis.com/testim/content/salesforce-testing/faq.htm)

### Inferences
- Tosca's Container-uniqueness caveat is the same failure mode as our "same label in two places" ambiguity. Scoping by container (section, related list, modal) only works when the container name is itself stable.
- Testim's "filter dynamic ids" is what we already do on Salesforce runs (`liveDomDiscovery.ts` skips `-\d+$` and `\w+-\d+-\d+` ids).

### Gaps
- No official Tosca documentation retrieved explains which DOM or metadata properties the Salesforce engine uses to identify a control, or how modules survive releases. The docs.tricentis.com pages could not be fetched, and the search budget ran out.
- No independent measurement of Testim's self-healing on Salesforce was found.

---

## 5. Keysight Eggplant for Salesforce

### Takeaway
Not researched. The search budget was exhausted before this item.

### Cited Findings
- None.

### Inferences
- None. Eggplant is primarily image- and model-based. That is background knowledge only and was not verified this session.

### Gaps
- Eggplant's Salesforce-specific capabilities (if any, as of 2026) were not researched; this needs a follow-up session with search budget.

---

## 6. Salesforce's own guidance: hidden ids, shadow DOM, waiting for Lightning, Locker/LWS, synthetic vs native shadow

### Takeaway
Salesforce says openly that Lightning **deliberately hides element identifiers** and that shadow boundaries break traditional locators. Its sanctioned answer is UTAM.
- Aura's own "waiting" event is deprecated, so there is no supported framework-level "idle" API to hook.
- Readiness has to be inferred from observable signals: component presence (UTAM `beforeLoad`), spinners, network, and DOM quiet.

### Cited Findings
- **[Official]** "With Lightning, Salesforce made a conscious decision to hide identifiers on its elements", which hampers automation that relied on them. LWC uses shadow DOM, and shadow boundaries "break traditional means of locating elements". — [Salesforce Developers blog: UI Test Automation on Salesforce (Jan 2020)](https://developer.salesforce.com/blogs/2020/01/ui-test-automation-on-salesforce)
- **[Official]** `aura:waiting` signalled that the framework was waiting on a server response, firing on `$A.enqueueAction()` and Apex calls. It is marked **deprecated**; the recommended replacement is to run logic after queuing an action. — [Salesforce: aura:waiting (Deprecated)](https://developer.salesforce.com/docs/platform/lightning-component-reference/guide/aura-waiting.html)
- **[Official]** Field API names are found under Setup › Object Manager › object › Fields & Relationships. — [Salesforce: lightning-input-field](https://developer.salesforce.com/docs/platform/lightning-component-reference/guide/lightning-input-field.html)
- **[Third-party]** Since Spring '24, Dynamic Forms fields in Lightning App Builder show an "API Name" property. — [asagarwal.com](https://www.asagarwal.com/salesforcespring24-see-object-name-field-api-name-in-dynamic-forms/)
- **[Official]** The Tooling API `Layout` object represents a page layout, with `fullName` as its unique API identifier. — [Salesforce Tooling API: Layout](https://developer.salesforce.com/docs/atlas.en-us.192.0.api_tooling.meta/api_tooling/sforce_api_objects_layout.htm)
- **[Primary-code]** In practice, readiness in Salesforce's own page objects is component-presence based:
  - `beforeLoad` waits for `.forcegenerated-flexipage-module` inside `one-record-home-flexipage2`;
  - `waitForItemsToLoad` waits for `lightning-base-combobox-item`;
  - lookup `waitUntilReady` waits for not-disabled.

  67 page objects reference `lightning-spinner` or `slds-spinner`. — [npm: salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects)
- **[Third-party] Community readiness implementation** (`salesforce-utam`'s `waitForReady`):
  - wait for the `load` event;
  - then poll every 100 ms until no visible element matches `.slds-spinner, lightning-spinner, .loadingIndicator, .auraLoadingBox` for 400 ms;
  - treat a destroyed execution context (navigation in flight) as busy;
  - time out after 30 s.

  Its toast wait uses `.slds-notify_toast, .slds-notify--toast` and reads `.toastMessage, .slds-notify__content`. — [npm: salesforce-utam](https://www.npmjs.com/package/salesforce-utam)
- **[Vendor-mkt]** Other vendors' summaries:
  - Parasoft: Salesforce identifiers "change randomly between page visits".
  - QA Wolf: most Salesforce DOM elements are generated dynamically, and developers cannot inject persistent IDs or test attributes.
  - Gearset: platform updates can break even stable suites.
  — [Parasoft](https://www.parasoft.com/blog/tips-tricks-for-testing-salesforce-enterprise-apps-with-selenium/); [QA Wolf](https://www.qawolf.com/blog/three-main-challenges-of-testing-salesforce); [Gearset: UI testing challenges](https://gearset.com/blog/salesforce-ui-testing-challenges/)

### Inferences
- The pattern is the same across Salesforce, Copado and the community: no single "Lightning is idle" signal exists. Robust tools combine:
  - a component-specific presence condition (for the thing about to be used);
  - spinner absence, using paint-aware visibility;
  - network idle that excludes long-poll;
  - a short bounded DOM-quiet window.
- Our current `waitForScreenSettle` (`liveExtend.ts`) covers spinner absence plus a stable control count, but has no network signal.

### Gaps
- The following were not researched (search budget exhausted):
  - how **Lightning Web Security / Locker** affect external automation;
  - **synthetic vs native shadow DOM** in Lightning Experience versus LWR Experience Cloud sites. With synthetic shadow, DOM queries and `shadowRoot` behave differently from native shadow, so this matters for our open-shadow-root walker;
  - any `$A`-based idle check;
  - Trailhead guidance on UI testing.

  These are worth a dedicated follow-up.
- `salesforce-utam` signs in with `frontdoor.jsp?sid=<access token>`. Whether Salesforce still permits a session id as a GET parameter on `frontdoor.jsp` in 2026 orgs was **not verified**.

---

## 7. Which Lightning/LWC DOM attributes are stable across sessions and releases?

### Takeaway
No attribute is a documented, versioned contract. Salesforce re-publishes its page objects every release precisely because internals move.

The best evidence of "Salesforce-endorsed, stable for the current release" is what Salesforce's own Spring '26 page objects select on:
- custom-element **tag names**;
- **`data-value`** on combobox items (the API value);
- **`field-label`** and **`[data-target-selection-name]`** on record-layout items;
- **`slot`** names;
- **`data-field`** on compound sub-fields;
- `data-close-button`, `data-modal` and `data-help-text`;
- **ARIA roles and states**.

Generated `id`s are explicitly not used.

### Cited Findings
- **[Primary-code]** Frequency of attribute selectors across all 1,638 Salesforce page objects (my count of `css` selectors):

  | Count | Attribute |
  |---|---|
  | 149 | `slot` |
  | 122 | `class` |
  | 113 | `data-id` (component-author ids, e.g. `lightning-radio-group[data-id='conditionScope']`) |
  | 60 | `role` (e.g. `input[role='combobox']`) |
  | 59 | `name` (mostly `slot[name=…]`) |
  | 46 | `type` |
  | 45 | `id` (mostly partial `id*=`) |
  | 43 | `title` |
  | 33 | `value` |
  | 17 | `data-label` (datatable cells, `td[data-label='Product']`) |
  | 15 | `data-component-id` |
  | 13 | `data-field` |
  | 9 | `data-aura-class` (partial `*=`) |
  | 7 | `data-target-selection-name` |
  | 6 | `aria-label` |
  | 3 | `data-field-id` |

  — [npm: salesforce-pageobjects@12.0.0](https://www.npmjs.com/package/salesforce-pageobjects)
- **[Primary-code]** Attributes Salesforce's page objects rely on:
  - `records-record-layout-item[field-label]`, which the `getLabelText` method reads;
  - `[data-target-selection-name]` = "the target field's API name" (`getTargetField` method);
  - `lightning-base-combobox-item[data-value]` = the option's value;
  - the trigger input's `data-value` = the currently selected value;
  - `[slot='inputField']` and `[slot='outputField']` = edit versus view state of a record field;
  - `lightning-input[data-field='firstName'|'lastName'|'middleName'|'suffix'|'informalName'|'city'|'postalCode'|'province'|'country']` and `lightning-picklist[data-field='salutation'|'country'|'province']` for compound name and address fields.

  — [npm: salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects) (`records/recordLayoutItem.utam.json`, `lightning/baseCombobox.utam.json`, `lightning/inputName.utam.json`, `lightning/inputAddress.utam.json`)
- **[Primary-code]** `flexipage-field[data-field-id]` (Dynamic Forms) appears only in a page object marked "in development and will not be available to customers", so it is **not** an endorsed hook. — [npm: salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects) (`flexipage/column2`)
- **[Official]** Aura components expose `data-aura-class`; LWCs are identified by custom tag name. — [Salesforce: Find Salesforce Page Objects](https://developer.salesforce.com/docs/platform/utam/guide/find-sf-page-objects.html)
- **[Official]** Identifiers are hidden by design. — [Salesforce Developers blog (2020)](https://developer.salesforce.com/blogs/2020/01/ui-test-automation-on-salesforce)

### Inferences
- The ranking for our selector ladder on Salesforce:
  1. ARIA role plus accessible name, scoped to a container (dialog or section);
  2. label-anchored, or the `field-label` host;
  3. `data-value` for options;
  4. tag name plus `data-field` for compound sub-fields;
  5. never generated `id`s.
- Use `data-target-selection-name` as **metadata** (the field API name, recorded in the AppModel for traceability and grounding) rather than as the primary runtime selector, because it is undocumented.
- On `name` on `lightning-input` and `field-name` on `lightning-input-field`: in LWC, values passed from a template to a child component are set as *properties*, which are not necessarily reflected as DOM *attributes*. So `field-name` and `name` may be absent from the rendered DOM. Verify on a live org before relying on them. (Inference from LWC semantics; not sourced this session.)

### Gaps
- No Salesforce document commits to any of these attributes being stable across releases.
- The `field-label` and `data-target-selection-name` attributes were confirmed only through page-object code, not observed in a live org this session.

---

## 8. Test data creation and cleanup on Salesforce

### Takeaway
Every specialist tool creates prerequisite records through the **API, not the UI**, captures the returned IDs, and deletes them in a teardown. Testim adds a naming convention (prefix plus random suffix) and child-first deletion for sweep-style cleanup. Salesforce added an Apex `@TearDown` annotation (developer preview, Summer '26) for committed integration-test data.

### Cited Findings
- **[Official]** Provar uses API steps: Create (ID into a variable), SOQL, Delete, and Apex Bulk Delete/Hard Delete, plus folder-level teardown test cases. — [Provar docs: Setup and Teardown](https://documentation.provar.com/documentation/support/setup-and-teardown-test-cases); [Provar: Salesforce API Testing](https://documentation.provar.com/documentation/v3/automation-salesforce-api-testing/); [Provar: Apex Bulk](https://documentation.provar.com/documentation/using-the-test-palette/salesforce/apex-bulk/)
- **[Official]** Testim: Execute Apex cleanup by prefix plus random suffix, children before parents. — [Testim docs](https://docs.tricentis.com/testim/content/salesforce-testing/best-practice-variable-naming-convention-for-easy-cleanup.htm)
- **[Third-party]** `salesforce-utam`:
  - `createRecord` and `deleteRecord` call `sf data create record` and `sf data delete record`;
  - `soql` calls `sf data query`;
  - the browser session comes from the CLI access token, so "no username or password ever appears in test code".
  — [npm: salesforce-utam](https://www.npmjs.com/package/salesforce-utam)
- **[Official]** Apex unit-test data is rolled back automatically. The `@TearDown` annotation (developer preview, Summer '26, API 67.0) marks a static cleanup method for *committed* integration-test data, and it runs whether the test passes or fails. — [Salesforce: Understanding Test Data](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/api/apex_testing_data.htm); [Salesforce: TearDown Annotation](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/api/apex_classes_annotation_TearDown.htm)

### Inferences
- For our pipeline, API seeding would remove whole classes of flaky UI pre-steps. One example is "create an Account so the lookup has something to find". Our lookup problem, where suggestions are not in the DOM until typed, becomes deterministic when the test seeds the target record with a known unique name and types that name.
- Seeding must respect our rule 5 on credentials. An OAuth or CLI token held in memory for one walk fits that rule; a stored password does not.

### Gaps
- No source was found for Copado's or Tosca's Salesforce data-seeding steps (search budget).

---

## 9. Adoptable techniques for our pipeline

### Takeaway
The highest-value, lowest-risk adoptions are:
1. a **Salesforce readiness probe** with a network-idle signal that ignores CometD long-polling (QWeb);
2. **UTAM-derived interaction recipes** for combobox, picklist, lookup and record fields, keyed by the `data-value` and label hooks Salesforce's own page objects use;
3. recording **`data-target-selection-name` / `field-label`** as field metadata in the AppModel for grounding;
4. **API-seeded test data** with prefix-named records and teardown.

Each item below is flag-gated, Salesforce-runs-only, and checked structurally, in line with `CLAUDE.md` rules 2 and 7 and its central design rule.

### Cited Findings (each technique and its basis)
1. **Network-aware readiness wait (Salesforce runs).** Extend `waitForScreenSettle` to the QWeb order:
   1. readyState complete;
   2. pending fetch/XHR count is 0, with requests whose body contains `"connectionType":"long-polling"` excluded;
   3. no visible spinner;
   4. a bounded DOM-quiet window (around 200–400 ms, capped at around 1.5 s);
   5. on timeout, continue with a logged warning rather than fail.

   Install the monitor with `page.addInitScript` so it exists before Lightning boots. The callback must be fully inlined, with no inner named functions (TD-40). — Basis: [QWeb xhr.py](https://github.com/qentinelqi/qweb/blob/master/QWeb/internal/xhr.py), [install_monitor.js](https://github.com/qentinelqi/qweb/blob/master/QWeb/internal/js/install_monitor.js)
2. **Broaden and harden the spinner set.**
   - Add `lightning-spinner`, `.loadingIndicator`, `.auraLoadingBox` and `.slds-spinner:not(.slds-hide)` to `BUSY_SELECTOR`.
   - Judge a spinner busy only if it **paints**: non-zero area inside the viewport, not opacity 0 or visibility hidden, and topmost at its centre through `elementFromPoint`. Without this, a hidden or covered spinner stalls the wait.

   — Basis: [QWeb spinner_busy.js](https://github.com/qentinelqi/qweb/blob/master/QWeb/internal/js/spinner_busy.js); [salesforce-utam waitForReady](https://www.npmjs.com/package/salesforce-utam)
3. **Component-presence readiness before acting.** Before acting on a record page, wait for `one-record-home-flexipage2 .forcegenerated-flexipage-module`. After opening a combobox or lookup, wait for a `lightning-base-combobox-item` to exist rather than using a fixed 500 ms. This replaces the "wait 500" advice in `salesforceGuidance.ts` with deterministic, element-based waits in the generator. — Basis: [salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects) `global/recordHomeTemplateDesktop.utam.json`, `lightning/baseCombobox.utam.json`
4. **Picklist recipe in the generator, no LLM.**
   1. Click the combobox trigger (`input[role='combobox']` or `button` inside `lightning-base-combobox`).
   2. Wait for `div.slds-dropdown_fluid` to be visible.
   3. Select the option by **`lightning-base-combobox-item[data-value="<API value>"]`** when the value is known; otherwise by exact `.slds-media__body` text or the role=option accessible name.
   4. Verify the trigger's `data-value` (or displayed text) afterwards.

   Discovery should record each option's `data-value` alongside its label when the list is opened, so the IR can ground on the value, which is locale-proof, rather than the label. Also handle the other two picklist render variants, `lightning-dual-listbox` (multi-select) and `lightning-select`. — Basis: `lightning/baseCombobox.utam.json`, `lightning/baseComboboxItem.utam.json`, `lightning/picklist.utam.json` in [salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects)
5. **Lookup recipe.**
   1. Wait until the input is enabled (`waitUntilReady`).
   2. Focus and type the search text.
   3. Wait for `lightning-base-combobox-item` to appear.
   4. Click the item whose label **equals** the expected record name, skipping `data-value` `actionAdvancedSearch` and `actionCreateNew`.
   5. Assert that the selection pill label equals the name.

   For grounding, treat the suggestion as a **runtime-resolved target** that is checked structurally: it must be a `lightning-base-combobox-item` under the lookup that was grounded. Do not reject it because it was absent at discovery time. This turns the "end the case before choosing a suggestion" rule in `salesforceGuidance.ts` into a supported action. Pair it with technique 9 so the name is known. — Basis: `lightning/lookupDesktop.utam.json` in [salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects)
6. **Field metadata in the AppModel.** During live discovery, when an element sits inside `records-record-layout-item`, record two things:
   - its `field-label` attribute, as the label (more reliable than nearby text);
   - the `data-target-selection-name` of its inner wrapper, as an optional `fieldApiName` field.

   This is a new optional Zod field (`CLAUDE.md`: extend the schema first). Use it for grounding and diagnosis, and to tell same-label fields apart across sections, not as the primary selector. — Basis: `records/recordLayoutItem.utam.json` (`getLabelText`, `getTargetField`) in [salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects); analogous to Provar's metadata binding: [Provar blog](https://provar.com/blog/product/provar-automations-most-relevant-features-salesforce-metadata-aware-authoring/) (vendor)
7. **Compound name and address fields.** Ground sub-inputs by host tag plus `data-field` (`lightning-input[data-field="lastName"]`, `lightning-picklist[data-field="salutation"]`). Their visible labels repeat across Billing and Shipping address blocks, so label-only matching is ambiguous there. — Basis: `lightning/inputName.utam.json`, `lightning/inputAddress.utam.json` in [salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects)
8. **Disabled and read-only state from Salesforce's own signals.** A combobox is disabled when its trigger class contains `slds-is-disabled`, and read-only when `aria-readonly="true"`; inputs use the native `disabled` or `readonly` attribute. Fold these into the existing "reject acting on a disabled element" check, and wait-until-enabled before acting on a button known to enable after a selection. — Basis: `lightning/baseCombobox.utam.json`, `lightning/input.utam.json`, `lightning/lookupDesktop.utam.json` in [salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects)
9. **API-seeded data with a prefix and teardown (new flag, default off).**
   - Create prerequisite records via the REST API using an in-memory token.
   - Name them `<runPrefix>-<random>`, keep the returned IDs in memory, and delete them after the run, children before parents, with a prefix-SOQL sweep as a backstop.
   - Never write the token to disk (rule 5).
   — Basis: [Provar teardown](https://documentation.provar.com/documentation/support/setup-and-teardown-test-cases); [Testim prefix cleanup](https://docs.tricentis.com/testim/content/salesforce-testing/best-practice-variable-naming-convention-for-easy-cleanup.htm); [salesforce-utam data helpers](https://www.npmjs.com/package/salesforce-utam)
10. **Token-based login as an alternative to the two-screen form.** Establish the browser session from an OAuth access token via `/secur/frontdoor.jsp`, which is how `sf org open` works. This avoids username/password screens and MFA prompts entirely for orgs where the person can supply a CLI or OAuth session. **Verify** that the `sid` GET parameter is still accepted before relying on it (see the Gap in section 6). — Basis: [salesforce-utam](https://www.npmjs.com/package/salesforce-utam) (`frontdoorUrl`)
11. **Setup and Visualforce iframes.** Recognize `force-aloha-page` › `iframe[name^="vfFrameId"]` as the Classic-in-Lightning frame and descend into it during discovery and execution. It is same-origin in many orgs, but where it is cross-origin, report it explicitly rather than silently find nothing. — Basis: `force/alohaPage.utam.json` in [salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects)
12. **Modal scoping, already done (TD-72); keep it.** This matches QWeb's `IsModalXpath`: while a modal exists, search only inside it. Use `lightning-modal` (header, body, footer) and `[data-close-button]` as structural hooks for the dialog and its close control. — Basis: [QWeb config.py](https://github.com/qentinelqi/qweb/blob/master/QWeb/keywords/config.py); `lightning/modal.utam.json` in [salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects)
13. **Robust text entry.** For `lightning-input`:
    1. scroll to centre;
    2. click;
    3. select-all and Delete, then **re-read the value**, and fall back to `clear()` if it is not empty;
    4. type.

    Then verify the value. Lightning inputs sometimes ignore a plain programmatic clear. — Basis: `lightning/inputUtils.utam.js` in [salesforce-pageobjects](https://www.npmjs.com/package/salesforce-pageobjects)
14. **Text in `<slot>`s.** When a visible label or link text resolves to a `<slot>` (zero layout box), retarget to the nearest clickable ancestor (`<a>` or `<button>`) rather than reporting "not visible". — Basis: [QWeb text.py `get_slot_elements`](https://github.com/qentinelqi/qweb/blob/master/QWeb/internal/text.py)
15. **Mine UTAM page objects offline as a deterministic knowledge base.** Distil the `salesforce-pageobjects` JSON into a small table. Note the licence: the package is **not** MIT. It ships under Salesforce's own "Terms of Use" (2022), which grant a royalty-free licence to reproduce and make derivative works, but include an indemnity clause and a usage-data clause, so review it before vendoring files. Re-deriving the facts we need (selectors and wait conditions) into our own table is lower-risk than copying files. The table maps: component tag → {open action, wait condition, option selector, value attribute, state checks}. The generator and diagnoser can then look up a recipe by the grounded element's host tag. The table is refreshed per Salesforce release (new major version per release), and the release tag should be part of any cache key that depends on it (TD-22, D-10). — Basis: [npm: salesforce-pageobjects dist-tags](https://www.npmjs.com/package/salesforce-pageobjects)

### Inferences
- Items 1–5 and 8 directly address problems we have hit:
  - late Apex data;
  - custom LWC comboboxes and picklists;
  - lookups whose suggestions are absent until typed;
  - buttons disabled until a selection;
  - modals.
- Items 6, 7 and 15 improve **grounding**, matching our central rule of checking structure over prose.
- Items 9 and 10 change login and data setup, so they need new env flags, default OFF.
- A fixed `wait 500` in prompt guidance is a prompt-level preference. Replacing it with generator-emitted, element-based waits (item 3) is exactly the "deterministic check behind every prompt rule" that `CLAUDE.md` asks for.
- Experience Cloud: UTAM, Provar NitroX (opt-in) and our pipeline all have weak coverage. For `my.site.com` sites, role, accessible-name and label strategies plus the generic readiness probe (items 1–2) are likely the only broadly applicable techniques; the vendor page objects will not help much there.

### Gaps
- None of these techniques has been validated against a live org in this session. Each Playwright expression should be run once against a synthetic page or a real org before shipping (`CLAUDE.md`, D-19).
- Synthetic vs native shadow behaviour, Lightning Web Security, Copado's Salesforce keyword library and AI features, Tosca's control-identification internals, and Eggplant all remain unresearched because the search budget ran out. Each is worth a follow-up.
