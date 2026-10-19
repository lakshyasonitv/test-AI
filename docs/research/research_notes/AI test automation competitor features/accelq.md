# ACCELQ: documented mechanisms (as of Oct 2026) and what our pipeline could adopt

**Method and source reliability, read first.**
- `support.accelq.com`, `www.accelq.com`, `academy.accelq.com` and `naukri.com` could not be fetched from this environment. WebFetch returned `getaddrinfo ENOTFOUND`, and curl through the agent proxy got `CONNECT tunnel failed, 403`.
- Every finding below therefore comes from **search-engine excerpts of the cited pages, not from reading the full pages.** The URLs are real article URLs returned by search, but the wording is the search engine's quote or paraphrase. Treat exact phrasing as approximate.
- The session's shared web-search budget (200 calls per turn) ran out partway through. Some planned queries were never run, and they are listed under **Gaps**.
- **Source tags used throughout:**
  - **[DOC]** a support.accelq.com help-centre article (vendor product documentation).
  - **[REL]** release notes on support.accelq.com.
  - **[MKT]** accelq.com blog, landing, news or event pages (marketing).
  - **[3P]** third party: reviews, comparison sites, resellers, cheat sheets.
- Version anchors found:
  - 6.0 "SKYBOLT" is from 2023.
  - 6.1 introduced locator-free.
  - 6.2 is from mid-2024.
  - Release 7.0 introduced Autopilot GenAI. Its page was about 19 months old at search time, so roughly early 2025, and the Local Agent 7.0 notes are dated 16 Feb 2025.
  - **No 8.x release notes surfaced.**

## 1. Application modelling: Context, View, Destination Context, Universe, scenario continuity

### Takeaway
ACCELQ models an app as a graph:
- **Contexts** are app states or pages.
- **Views** are captured snapshots of a Context. A Context can have several.
- **Actions** are the edges. Each Action has an **Owner Context**, one or more **Origin Contexts**, and a **Destination Context** (specific, "Current", or multiple).

The Scenario builder **enforces continuity structurally**: step N+1 is only "relevant" if its Origin Context matches step N's Destination Context. Out-of-sequence picks raise a "Missing Step" alert. The "Application Universe" is a visual map of this graph that builds up as you develop tests. It is not presented as a separate crawl.

### Cited Findings
- **Context**
  - A Context is "a placeholder for a particular state of the application under test". For UI it stands for a web page, mobile screen or window, for example a login page or account summary page. Actions are defined per Context. [DOC] [What is a Context](https://support.accelq.com/hc/en-us/articles/4402891065101-What-is-a-Context)
- **View**
  - A View is "a screen recording of the page the Context represents". A Context may have one or more Views, each capturing a different sub-state of the page. Views belong to the Context, are shared with its Actions, and support element identification. [DOC] [What is a View](https://support.accelq.com/hc/en-us/articles/4402898020237-What-is-a-View); [What is a Context](https://support.accelq.com/hc/en-us/articles/4402891065101-What-is-a-Context)
  - When a View is captured, ACCELQ "analyzes the web page and saves metadata" so elements can be analysed later (offline element authoring against a snapshot). [DOC] [Adding Element to Repository](https://support.accelq.com/hc/en-us/articles/115010131627-Adding-Element-to-Repository)
- **When to add a View, and when not to**
  - Add one when a page "may expose a set of new UI controls upon some action on the page", for example a calendar from a date field or an "Advanced Options" panel.
  - "New view will be required ONLY if your action logic needs to perform any interaction with the elements that the view will bring."
  - "Do not create multiple Contexts in such situations", and do not capture extra Views just for data differences.
  - [DOC] [Why do I ever need multiple Views for a Context?](https://support.accelq.com/hc/en-us/articles/360000692332-Why-do-I-ever-need-multiple-Views-for-a-Context)
- **Self-managed Views (6.0)**
  - Views for web apps are captured automatically while recording in the Logic Recorder. The system "automatically picks the best set of Views for each Context".
  - Later logic can be authored by right-clicking a stored View to generate a statement, without re-navigating the live app.
  - [REL] [What's new in ACCELQ 6.0](https://support.accelq.com/hc/en-us/articles/10127655884813-What-s-new-in-ACCELQ-6-0)
  - Older and newer docs still describe manual View hygiene: a "View Purge" from the Context home page. Purging elements before Views keeps "the minimum set of Views needed to cover the remaining elements". Unused Views "slow the workspace". [DOC] [Managing Views…](https://support.accelq.com/hc/en-us/articles/35821273411981-Managing-Views-in-ACCELQ-Keeping-Your-Contexts-Clean-and-Efficient); [Managing a Context](https://support.accelq.com/hc/en-us/articles/360023736392-Managing-a-Context)
  - *Conflict:* 6.0 says Views are self-managed, while purge guidance persists. The docs do not say which applies to which version.
- **Modals**
  - Worked example: the Salesforce "New Lead" modal, reachable from several places and always landing on the Lead Information Page.
  - Options: model the modal as a **View inside a Context it is reachable from**, or as its **own Context**.
  - Split into two Actions: one that only opens the modal ("Initiate new Lead") and one that works inside it ("Create New Lead"). **Share** the inner Action with every Context the modal can be invoked from.
  - Modals with "independent global scope" should be separate Contexts, so base Contexts don't fill up with modal Views.
  - [DOC] [Designing Contexts and Actions for modal windows](https://support.accelq.com/hc/en-us/articles/360001619091-Designing-Contexts-and-Actions-for-modal-windows)
- **Destination Context: three options**
  - **Specific Context**: for example login always leads to "User Home Page".
  - **Current Context**: for Actions that don't change the visual state. "Most commonly, Validation Actions do not alter the state of a context". Also common for modal-type pages.
  - **Multiple Destination Contexts.**
  - [DOC] [Defining Destination Context for an Action](https://support.accelq.com/hc/en-us/articles/360021044992-Defining-Destination-Context-for-an-Action)
- **How "Current Context" is evaluated**
  - For a shared Action it "resolves to the actual Context on which the Action is exercised in the Scenario workflow".
  - Picking the named page instead hard-codes it ("If you select 'Home Page', then the destination is hard coded to this in all situations").
  - [DOC] ["Current Context" as Action destination - How is it evaluated?](https://support.accelq.com/hc/en-us/articles/115005170107--Current-Context-as-Action-destination-How-is-it-evaluated); ["Current Context" is not same as picking the actual name…](https://support.accelq.com/hc/en-us/articles/115010299568--Current-Context-is-not-same-as-picking-the-actual-name-of-the-current-Context)
- **Nested Actions**
  - "The Destination Context of the called Action must either match with the Destination Context of the 'caller' Action or it should be 'Current Context'." [DOC] [Calling an Action inside another](https://support.accelq.com/hc/en-us/articles/115010299988-Calling-an-Action-inside-another)
- **Multiple destinations**
  - Example: Login leads either to Dashboard or to the Password Expiration page by business rule. Login may also leave the user on the Login Page on invalid credentials.
  - **When a multi-destination Action is placed in a Scenario, the user must select which destination applies for that flow.** [DOC] [Examples: Multiple Destination Contexts for Action](https://support.accelq.com/hc/en-us/articles/360021308872-Examples-Multiple-Destination-Contexts-for-Action)
  - Alternative pattern: put shared logic in one generic Action with destination "Current Context", then wrap it in separate Actions, each with a fixed destination. [DOC] [How do you handle Actions with multiple possible destination Contexts](https://support.accelq.com/hc/en-us/articles/360012242852-How-do-you-handle-Actions-with-multiple-possible-destination-Contexts)
- **Origin, Owner and applicability**
  - Origin Context is "the Context (page) where the Action is possible to run". An Action can have several Origins, for example Logout on many pages.
  - Applicability covers where an Action can be a step, what can follow it, and which Actions can call it.
  - [DOC] [Configuring applicability of an Action](https://support.accelq.com/hc/en-us/articles/360062001392-Configuring-applicability-of-an-Action)
  - The Owner Context owns the Elements and Views the Action needs. There is exactly one Owner, and it is always one of the Origins. An Action can be moved only together with its dependencies. [DOC] [Difference between Owner Context and Origin Context](https://support.accelq.com/hc/en-us/articles/4527464918669-Difference-between-Owner-Context-and-Origin-Context)
- **Scenario continuity (the structural check)**
  - The Step Selector shows "Relevant Actions": those available on the current Context plus all library Actions.
  - "Once a step is added, subsequent steps must have an 'Origin Context' that matches the 'Destination Context' of the step just added."
  - An **Init Action** can be inserted anywhere to start a new browser or sub-flow.
  - Picking an Action outside the relevant set offers two choices: proceed with a **Missing Step alert**, or **share the Action into the current Context**.
  - [DOC] [Selecting steps while building a Scenario](https://support.accelq.com/hc/en-us/articles/360060372771-Selecting-steps-while-building-a-Scenario); [Options when selecting an out-of-sequence Action](https://support.accelq.com/hc/en-us/articles/360060373231-Options-when-selecting-an-out-of-sequence-Action)
  - The Workbench "Add Step" lists the most relevant Actions first, described as an AI-driven relevance engine. [DOC] [Building a Scenario in WorkBench](https://support.accelq.com/hc/en-us/articles/12307563417869-Building-a-Scenario-in-WorkBench)
- **Application Universe**
  - "Formed automatically as part of your test development".
  - Map view: circles are Contexts and lines are Actions. A sidebar lists scenarios with status and alert filters.
  - Opening a scenario filters the Universe to show its steps "in a graphical application traversal format".
  - [DOC] [Application Universe](https://support.accelq.com/hc/en-us/articles/360026201612-Application-Universe)
  - Marketing adds "predictive and path analysis" for designing scenarios, change-impact analysis, and coverage of pages, navigation paths, API calls and backend interactions. [MKT] [ACCELQ Product Overview](https://www.accelq.com/blog/accelq-product-overview/); [3P] [qatestingtools listing](https://www.qatestingtools.com/testing-tool/accelq)
- **Contexts on the fly**
  - Contexts and Actions can be created on the fly while building. Article title only; no excerpt. [DOC] [Creating Actions and Contexts on the fly](https://support.accelq.com/hc/en-us/articles/360059931532-Creating-Actions-and-Contexts-on-the-fly)

### Inferences
- ACCELQ's continuity guarantee is a **type check on the graph**: Origin must equal the previous Destination. It needs neither a model nor page text, and it is the strongest transferable idea in this section.
- "Current Context" is a **polymorphic destination**: the Action does not change state, so the destination equals wherever it was called from. It gives validation steps and in-page widgets a well-defined meaning without fabricating new states.
- The Universe is a **by-product of authoring and recording**, not of an autonomous crawler (except possibly in the newer marketing "Universe Discover Agent", section 5). This is the reverse of our DOM-first discovery.

### Gaps
- How SPA route changes that keep the same page are modelled: not documented. The only relevant guidance is "new View only if logic interacts with the revealed controls".
- How browser tabs and windows are modelled: not found.
- Whether the Universe is stored as an exportable graph, and its storage format: not documented.
- Whether path analysis generates scenarios automatically: only marketing wording found.

## 2. Element identification: locator-free, Smart Locator, Element Explorer, repeat/family/abstract elements

### Takeaway
ACCELQ has two documented identification modes:
- **Locator-free** (default since 6.1) identifies an element by **label** (visible or related text, placeholder, button text, or a hidden textual property), an optional **anchor text** (visible text above or left of the target that limits the search area), and an **index** (screen position ordered from the upper-left). Labels and anchors accept text **operators**: equals ignoring case, starts with, ends with, contains, matches regex. Labels can also be parameters.
- **Smart Locator** is the fallback. It is an attribute combination chosen by a proprietary algorithm and edited in the Element Explorer, which shows a **live match count**. Ancestor and descendant (neighbourhood) nodes can be added, and attribute values can be JavaScript regexes.

Repeat elements, container/"family" scoping, table commands and abstract placeholder elements cover the rest.

### Cited Findings
- **Locator-free defaults**
  - Locator-free is the default "when generating statements, either via the Recorder or within the Logic Editor, whenever possible". The setting is under Resources > Project Preferences.
  - If no reliable hint can be computed, ACCELQ "defaults to Smart-Locators".
  - Smart Locator is also advised where locator-free "becomes too complicated", even with operators.
  - XPath and CSS custom selectors are for rare cases where Smart Locators can't build a selector.
  - [DOC] [Locator Options for Element Identification in Web Applications](https://support.accelq.com/hc/en-us/articles/17598987289997-Locator-Options-for-Element-Identification-in-Web-Applications); [Custom Selectors - XPath, CSS and JQuery](https://support.accelq.com/hc/en-us/articles/115010174947-Custom-Selectors-XPath-CSS-and-JQuery)
- **Label**
  - Visible or related text tied to the element: a field's label, button text, or placeholder. "The label could be a hidden textual property as well."
  - The locator-free method "uses an AI-powered algorithm to detect functionally significant screen information related to the Element of interest".
  - [DOC] [Locator-free Element Identification for Web Applications](https://support.accelq.com/hc/en-us/articles/13031514925453-Locator-free-Element-Identification-for-Web-Applications)
- **Anchor text**
  - Pick text "above or to the left of the target". It "limits the search for the label to the area under the designated anchor text, rather than the entire page".
  - Choose anchors that are consistent across use cases and have **functional meaning**, for example "Shipping Address".
  - Anchors accept the same operators and can be variables or parameters.
  - [DOC] [Locator-free…](https://support.accelq.com/hc/en-us/articles/13031514925453-Locator-free-Element-Identification-for-Web-Applications); [Best Practices for utilizing #Locator-Free Elements](https://support.accelq.com/hc/en-us/articles/18857862819981-Best-Practices-for-utilizing-Locator-Free-Elements); [Handling dynamic elements](https://support.accelq.com/hc/en-us/articles/360000198851-Handling-dynamic-elements)
- **Index**
  - A tie-breaker when label and anchor still match several elements.
  - "Based on the physical location of the element on the screen, typically ordered from the upper left corner of the screen."
  - [DOC] [Locator-free…](https://support.accelq.com/hc/en-us/articles/13031514925453-Locator-free-Element-Identification-for-Web-Applications)
- **Operators**
  - Equals (ignore case), starts with, ends with, contains, matches regex.
  - Examples:
    - "Submit Order" and "Submit Purchase" both match on the prefix "Submit".
    - A regex matches an 8-character alphanumeric transaction id.
    - A localized "Submit" button matches with starts-with.
  - [DOC] [Troubleshooting issues with Locator-free element identification](https://support.accelq.com/hc/en-us/articles/19052862960525-Troubleshooting-issues-with-Locator-free-element-identification); [Best Practices…](https://support.accelq.com/hc/en-us/articles/18857862819981-Best-Practices-for-utilizing-Locator-Free-Elements)
- **Parameterised labels**
  - "ACCELQ enables you to use a Local Parameter, Action Parameter, or Global Property as the label for Locator-free Element identification." [DOC] [Troubleshooting…](https://support.accelq.com/hc/en-us/articles/19052862960525-Troubleshooting-issues-with-Locator-free-element-identification)
- **When to use which**
  - Label-based identification is preferred when an element has a visible label. Smart Locators suit unlabeled elements such as toolbar icons.
  - The Recorder shows the computed label on hover.
  - [DOC] [Best Practices…](https://support.accelq.com/hc/en-us/articles/18857862819981-Best-Practices-for-utilizing-Locator-Free-Elements)
- **6.1 and 6.2 details**
  - Locator-free elements **do not appear in the Element Repository**; the hint lives in the test logic.
  - An inline element toolbar can convert Smart Locator to locator-free.
  - 6.2 added mapping from locator-free to Smart Locator for troubleshooting.
  - [REL] [What's new in Release 6.1](https://support.accelq.com/hc/en-us/articles/15164557127565-What-s-new-in-Release-6-1); [ACCELQ 6.2](https://support.accelq.com/hc/en-us/articles/26893382270093-ACCELQ-6-2-Unleashing-Next-Gen-Automation-Efficiency)
- **Smart Locator**
  - Elements are stored in the Element Repository with DOM-structure criteria, "a stable combination of HTML attributes".
  - "Conventional Smart Locators in ACCELQ still utilize our proprietary AI-based algorithms to detect the optimal combination of element attributes."
  - [DOC] [Locator Options…](https://support.accelq.com/hc/en-us/articles/17598987289997-Locator-Options-for-Element-Identification-in-Web-Applications)
- **Element Explorer**
  - Shows the DOM tree with ancestors labelled A1, A2… and descendants D1, D2….
  - Attributes can be ticked or unticked per node.
  - **The footer shows the number of elements matching the current criterion, recalculated live.**
  - [DOC] [Setting up Element Identification with Element Explorer](https://support.accelq.com/hc/en-us/articles/360026192152-Setting-up-Element-Identification-with-Element-Explorer)
  - The e-book says the match count should equal the number of on-screen occurrences, and that an index policy (first, last or n-th) can be set. [MKT] [Element ID Best Practices e-book (2021)](https://www.accelq.com/wp-content/uploads/2021/11/ACCELQ_E-Book_Element_ID_Best_Practices.pdf)
- **Neighbourhood identification**
  - When the element itself has no unique attributes, add one or more ancestors or direct descendants to the identifier.
  - Example: a "New Password" field becomes unique once an ancestor's `id` is added.
  - The Explorer "scans the entire neighborhood… to arrive at a combination of nodes and attributes that can provide a stable element ID".
  - [DOC] [Achieving element identification utilizing neighborhood nodes in DOM tree](https://support.accelq.com/hc/en-us/articles/360029525312-Achieving-element-identification-utilizing-neighborhood-nodes-in-DOM-tree); [Element Explorer](https://support.accelq.com/hc/en-us/articles/360026192152-Setting-up-Element-Identification-with-Element-Explorer)
  - Use the smallest attribute set that still gives uniqueness, because some attributes are more stable over time than others. [DOC] [Selecting appropriate attributes for element identification](https://support.accelq.com/hc/en-us/articles/360030721812-Selecting-appropriate-attributes-for-element-identification)
- **Dynamic ids**
  - Attribute values "can be specified as full fledged regular expression patterns". ACCELQ follows standard JavaScript regex syntax. [DOC] [Regular Expressions in Element ID](https://support.accelq.com/hc/en-us/articles/115010205127-Regular-Expressions-in-Element-ID); [Element Explorer](https://support.accelq.com/hc/en-us/articles/360026192152-Setting-up-Element-Identification-with-Element-Explorer)
  - A dedicated article covers dynamic properties with no fixed pattern or ID; title only. [DOC] [Element Identification is a challenge… Dynamic properties with no fixed pattern or ID](https://support.accelq.com/hc/en-us/articles/115006768908-Element-Identification-is-a-challenge-on-my-application-Dynamic-properties-with-no-fixed-pattern-or-ID)
- **Repeat elements**
  - "Set Repeat Element by Text" points a repeat element at the instance containing the given text, and accepts a regex. [DOC] [Handling dynamic elements](https://support.accelq.com/hc/en-us/articles/360000198851-Handling-dynamic-elements); [Working with Repeat Elements](https://support.accelq.com/hc/en-us/articles/360026192332-Working-with-Repeat-Elements)
  - Looping over repeating elements is documented; title only. [DOC] [How to loop on a set of repeating elements](https://support.accelq.com/hc/en-us/articles/360002692111-How-to-loop-on-a-set-of-repeating-elements)
- **Family / container anchor**
  - Example: hotel listings.
  - Save the wrapping box as a **Repeat element**, since items are functionally equivalent and uniqueness is not wanted.
  - Save member controls such as "Select Hotel" **as children of the container**, so they are searched for only inside that block.
  - At run time, point the Anchor Element at one instance and the family members resolve relative to it.
  - [DOC] [Working with family of dynamic, related fields (anchor or container element)](https://support.accelq.com/hc/en-us/articles/360002756632-Working-with-family-of-dynamic-related-fields-anchor-or-container-element); [Anchor Element](https://support.accelq.com/hc/en-us/articles/115010299788-Anchor-Element)
- **Tables**
  - Row and column numbers are 1-based, and the header row counts as a row.
  - An element repeating across cells must be set as a Repeat element.
  - "element Instance" selects the N-th occurrence in a cell (default first).
  - The row-match command matches on text in one column, a set of columns, or ANY column.
  - [DOC] [Working with HTML tables in accelQ](https://support.accelq.com/hc/en-us/articles/360029848751-Working-with-HTML-tables-in-accelQ); [Dynamically finding a row in html table with matching criteria](https://support.accelq.com/hc/en-us/articles/360043109051-Dynamically-finding-a-row-in-html-table-with-matching-criteria)
- **Abstract elements**
  - A placeholder for a UI element that doesn't exist yet (in-sprint automation).
  - Created via "New Web Element" or inline in the logic editor. "Generic Element" can be used if the type is unknown.
  - Later **reconciled against a captured View**.
  - Shown in **orange** in the editor; grounded elements are green.
  - [DOC] [Working with Abstract Elements](https://support.accelq.com/hc/en-us/articles/360023982131-Working-with-Abstract-Elements)
  - On reconciliation, compatible type changes are converted automatically, and "completely incompatible types produce blocking errors" for the user to review. [DOC] [Addressing incompatible types during element reconciliation](https://support.accelq.com/hc/en-us/articles/115006536428-Addressing-incompatible-types-during-element-reconciliation)
- **Reconciling after a UI change**
  - Layout changes or added fields usually need nothing "as long as the element attributes you are utilizing in the Element locator are not impacted".
  - Otherwise, capture a new View in the same Context. Repository elements that haven't changed "are automatically mapped to this new View".
  - For the rest: right-click the element in the new View, choose Element > "Save As", and pick the existing repository element to reconcile.
  - A type change such as link to button is "handled gracefully".
  - [DOC] [Reconciling Element Selectors when application UI is updated](https://support.accelq.com/hc/en-us/articles/360038632132-Reconciling-Element-Selectors-when-application-UI-is-updated); [Steps involved in reconciliation of a UI element](https://support.accelq.com/hc/en-us/articles/115007676428-Steps-involved-in-reconciliation-of-a-UI-element)
- **Iframes and shadow DOM**
  - Release 4.3 added "cross-domain nested iframe element identification". [REL] [What's new in Release 4.3](https://support.accelq.com/hc/en-us/articles/360046933191-What-s-new-in-Release-4-3)
  - Release 4.4 says "Element Debugger is now enhanced to support nested, dynamic iframes". [REL] [What's new in Release 4.4](https://support.accelq.com/hc/en-us/articles/360051186451-What-s-new-in-Release-4-4)
  - **No support article that explicitly documents shadow DOM handling surfaced in search.**
- **Text extraction**
  - "Get Web Page Text" takes a regex matching-pattern parameter. [DOC] [Using "Get Web Page Text" Command in Action Logic](https://support.accelq.com/hc/en-us/articles/32743839517453-Using-Get-Web-Page-Text-Command-in-Action-Logic)
  - An OCR-based automation mode exists; title only. [DOC] [Understanding ACCELQ OCR-Based Automation](https://support.accelq.com/hc/en-us/articles/33871092012941-Understanding-ACCELQ-OCR-Based-Automation)

### Inferences
- Locator-free maps closely onto our `Target` fields: `name`/`label`/`placeholder` correspond to ACCELQ's label and `nth` to its index.
- **The two pieces we lack** are:
  - **Anchor text**: a second, region-limiting text.
  - **Match operators** on the label.
- ACCELQ's index is **visual (upper-left screen order)**. Ours is 0-based DOM order. The two diverge on CSS-reordered layouts such as flex/grid `order` and Salesforce two-column record layouts.
- The live **match count** in Element Explorer is a uniqueness gate shown to the human. It is the same idea as a grounding check that a target resolves to exactly one discovered element.
- "Locator-free elements do not appear in the Element Repository" means the semantic hint is stored with the step, not in a shared object repository. That matches our IR design, where the target is stored inline in the step.

### Gaps
- The scoring or weighting inside Smart Locator: **not documented** ("proprietary AI-based algorithms").
- What counts as "related text" for a label (ARIA, `for=`, proximity radius): not documented.
- The exact geometric rule for "area under the anchor": not documented.
- Shadow DOM: no documentation found (the search budget ran out before a dedicated query).
- The "Working with Repeat Elements" article body was not surfaced.

## 3. Synchronisation

### Takeaway
There are three layers:
1. **Context-level Synch Point.** It runs implicitly before *any* Action in that Context. It is either page-level (title or text) or element-level (enabled/disabled, text, property/value, displayed/not).
2. **Explicit wait commands** in logic, each with its own timeout.
3. **Global timeouts** in the Run modal. The element timeout defaults to 30 s and the page timeout to 60 s.

The guidance for picking the sync element is structural: **unique to this page, stable, and late-loading**.

### Cited Findings
- **Synch Point types**
  - Two types: "Page Level Synch", which waits until the page achieves a characteristic such as expected title or page text, and "Element Level Synch", which waits until an element is enabled or not, has given text content, a property/value, or is displayed or not.
  - "This is an implicit synchronization which is automatically invoked before any Action in the given Context is executed."
  - It is set from the Context's Details sidebar > Synchronization > Setup Synchronization, choosing "Element on Page" or "Content or title on page".
  - [DOC] [Setting up Context Synchronization](https://support.accelq.com/hc/en-us/articles/360023724512-Setting-up-Context-Synchronization)
- **Choosing the sync element**
  - It must appear **only on this page**, because shared elements can falsely confirm that a page has loaded.
  - It should be stable across states.
  - It should be an element that "often loads late", so the rest of the page is usable once sync is done.
  - Otherwise, sync on page text or title.
  - [DOC] [Guidelines for setting up Synchcronization](https://support.accelq.com/hc/en-us/articles/115005242267-Guidelines-for-setting-up-Synchcronization) (sic)
- **Waits in test logic**
  - Context sync plus functional waits. Guidance is to put a wait statement at the **beginning of Action logic**.
  - "Wait for Web Element appear/enable" covers appear, disappear, enable and disable, each with its own maximum timeout.
  - [DOC] [Setting up synchronization in test logic](https://support.accelq.com/hc/en-us/articles/360000694612-Setting-up-synchronization-in-test-logic)
  - An article covers waiting until an element is enabled before interacting; title only. [DOC] [I want the automation runtime to wait until an element is enabled…](https://support.accelq.com/hc/en-us/articles/115005242247-I-want-the-automation-runtime-to-wait-until-an-element-is-enabled-before-starting-to-interact-with-the-page)
- **Timeout semantics by command class**
  - Interaction commands (Click, Enter Text) and **Verify** commands wait up to the Run-modal **Element Timeout**.
  - **Inspection** commands (for example "Is Web Element displayed") have **no timeout and return immediately**.
  - **Wait** commands use their own argument.
  - Condition-check commands offer None, "As Per Run Settings", or Custom.
  - [DOC] [Wait times for various commands and UI interactions during test execution](https://support.accelq.com/hc/en-us/articles/360030131851-Wait-times-for-various-commands-and-UI-interactions-during-test-execution)
- **Timeout defaults and settings**
  - **Element timeout default 30 s; page timeout default 60 s**, set per job in the Run modal under "PAGE / ELEMENT LOAD TIME".
  - "Page Load Timeout" bounds Context Synchronization. "Element Load Time" bounds element lookup.
  - [DOC] [Running Automation Test](https://support.accelq.com/hc/en-us/articles/115010299188-Running-Automation-Test); [How do you configure element and page timeouts in accelQ](https://support.accelq.com/hc/en-us/articles/360025195232-How-do-you-configure-element-and-page-timeouts-in-accelQ)
- **Action Insights (7.0)**
  - Gives AI-driven explanations and suggestions such as **replacing fixed delays with better wait strategies**. [REL] [What's new in Release 7.0](https://support.accelq.com/hc/en-us/articles/33991400145165-What-s-new-in-Release-7-0)

### Inferences
- The context-level sync point is a **per-state readiness predicate attached to the model, not to each test**. It runs automatically whenever a step's origin is that state. Our screen map already stores screens. A per-screen readiness predicate, chosen by the uniqueness rule above, is a direct port.
- The **inspection vs verify** split is worth copying semantically: an "is X visible?" branch condition must not wait, while an assertion should.

### Gaps
- Whether ACCELQ waits for network idle or DOM mutation quiescence: not documented.
- Auto-waiting for actionability (enabled, not covered) on every click: not documented beyond the element timeout.

## 4. Self-healing

### Takeaway
Self-healing is **on by default** and can be toggled per user in the Run modal. It applies to **Smart Locator elements** when the primary locator fails. It is **deliberately skipped where the element's presence is in doubt** (for example "wait for element to disappear"), and those cases are marked in the report.

Healing activity appears in a **visual section of the test report**, and ACCELQ says it "calibrates" healing data across a project's runs. **No approval or review workflow and no automatic repository write-back is documented**. The repository-update path that is documented is the manual "Save As" reconciliation.

### Cited Findings
- **Core behaviour**
  - Purpose: run-time identification failures from changing screens, UI updates, and mistakes in attribute picking.
  - "By default, self-healing is turned ON for all your test runs". It can be switched off in the Run modal, and the preference is cached for that user's future runs.
  - Reports include "a rich visual interface to display and analyze the self-healing activity", to trace the source of element flakiness.
  - Self-healing is skipped "for statements where the element's presence is doubtful, such as waiting for an element to disappear", and the report marks those cases.
  - ACCELQ "calibrates the self-healing data continually from various test runs that you perform in your Project".
  - [DOC] [Self Healing - Comprehensive approach to adaptive element identification](https://support.accelq.com/hc/en-us/articles/4420289421709-Self-Healing-Comprehensive-approach-to-adaptive-element-identification)
- **Scope and playback**
  - Settings table: "Enable Self-Healing: For Smart Locator elements, auto-recover when the primary locator fails."
  - In **Playback** (authoring), an element failure **pauses interactively** so the author can locate or map the element.
  - In a formal Scenario or Suite run the step **fails**, with Self-Healing recovering Smart Locator elements if it is enabled.
  - [DOC] [Playback and Validation](https://support.accelq.com/hc/en-us/articles/48792885705741-Playback-and-Validation)
- **Debug mode**
  - Debug mode pauses execution when an element is not found, so the user can interact and analyse. The report then includes a summary of that analysis. It shipped in Release 3.1.
  - [DOC] [Troubleshooting element identification during test execution](https://support.accelq.com/hc/en-us/articles/360025428892-Troubleshooting-element-identification-during-test-execution); [REL] [Release 3.1](https://support.accelq.com/hc/en-us/articles/360026020512-Release-3-1)
- **Release 7.0** lists "autonomous element healing for web automation" under Autopilot. [REL] [What's new in Release 7.0](https://support.accelq.com/hc/en-us/articles/33991400145165-What-s-new-in-Release-7-0)
- **Marketing and third-party descriptions**
  - Marketing describes an "Optimize Agent" doing self-healing, and a "Change Analyzer" agent that detects UI, schema, API and workflow changes and "repairs locators and remaps logic". [MKT] [ACCELQ wins AI-based engineering solution of the year 2026](https://www.accelq.com/news/accelq-named-ai-based-engineering-solution-of-the-year-2026/); [Agentic Automation in Testing: 2026 guide](https://www.accelq.com/blog/agentic-automation/)
  - One third-party blog describes ACCELQ healing as element fingerprinting with scored fallback matches. This is a secondary characterisation, not ACCELQ wording. [3P] [Ramotion review](https://www.ramotion.com/blog/accelq-autopilot-review/)
  - G2 reviewers mostly praise self-healing. [3P] [G2 pros and cons](https://www.g2.com/products/accelq/reviews?qs=pros-and-cons)

### Inferences
- Healing is a **runtime fallback with a report**, not a code change. That fits our D-27 rule ("a model proposes, it never writes"): a heal should be shown, and persisted only when a person approves it.
- The "skip when presence is doubtful" rule is a crisp, structural guard. Healing a `hidden` assertion or a wait-for-disappear step would make a passing test out of a bug.
- Locator-free elements are not listed as heal targets; the settings table names Smart Locator elements. This suggests the semantic (label/anchor) layer is treated as the resilient primary and healing protects the attribute layer. This is inference from one settings-table line.

### Gaps
- Which signals the healer uses (attributes, position, text, visual): **not documented**.
- Confidence thresholds: **not documented**.
- Whether healed locators are written back to the repository automatically or need approval: **not documented**.
- How "calibration" works: **not documented**.

## 5. Autopilot / GenAI

### Takeaway
What is documented, in the 7.0 release notes:
- Plain-English logic authoring in the Logic Editor.
- **Generate Test Steps**: choose an application and describe a business process, and it builds an end-to-end scenario. Test data and validations can be added afterwards.
- **AI Designer for Modularity**: groups logic into reusable components and auto-detects parameters.
- **Action Insights**: explanations plus improvement suggestions.
- Autonomous element healing.
- **Generate > Autopilot** creates test cases from a scenario's logic.

The agent lineup (Discovery, Change Analyzer, Optimize, Execution, Analyzer, Secure Data) and "Scenario Discovery Engine" appear **only in marketing, inconsistently**. **How generated steps are tied to real elements is not documented.**

### Cited Findings
- **Release 7.0 Autopilot features** [REL] [What's new in Release 7.0](https://support.accelq.com/hc/en-us/articles/33991400145165-What-s-new-in-Release-7-0)
  - "ACCELQ 7.0 introduces Generative AI-powered Natural Language Automation, allowing users to write automation logic in plain English."
  - "Generate Test Steps" builds end-to-end scenarios from a chosen application and a described business process, with test data or validations added afterwards.
  - "AI Designer for Modularity" groups test logic into reusable components and automatically detects parameters.
  - "Action Insights" gives AI explanations and suggestions such as replacing fixed delays.
- **Test cases from logic**
  - In the Test Cases area, **Generate > Autopilot** has AI create test cases from a scenario's logic.
  - When parameters are linked to Data Lists, cases can instead be generated algorithmically (All Pairs, Combinations).
  - [DOC] [Working with Test Cases in ACCELQ](https://support.accelq.com/hc/en-us/articles/41589227364237-Working-with-Test-Cases-in-ACCELQ)
- **Logic Editor (non-AI)**
  - Logic appears "in natural English". Statements come from recorded Views or are typed directly.
  - Typing "verify", "validate" or "check" surfaces command suggestions.
  - [DOC] [Working in Action Logic Editor](https://support.accelq.com/hc/en-us/articles/360052641931-Working-in-Action-Logic-Editor); [Recording Fundamentals](https://support.accelq.com/hc/en-us/articles/48792817708685-Recording-Fundamentals)
- **6.0 Ai-Record**
  - An embedded recorder in the Action Logic Editor that can also record verifications and assertions. [REL] [What's new in ACCELQ 6.0](https://support.accelq.com/hc/en-us/articles/10127655884813-What-s-new-in-ACCELQ-6-0)
- **Marketing claims (pages surfaced together by search; exact page per phrase not pinned)**
  - "Scenario Discovery Engine learns application workflows from live apps, wireframes, or business descriptions."
  - "Test Step Generator translates high-level test intent into full executable flows."
  - "No-Code Logic Builder converts natural language into automated logic with real-time preview and validation."
  - "QGPT Logic Builder translates complex business rules into automation logic that spans front-end, back-end, APIs, and middleware."
  - [MKT] [Autopilot named AI engineering solution of the year 2025](https://www.accelq.com/news/accelq-autopilot-wins-ai-breakthrough-award-2025/); [Comparing the best generative AI testing tools 2026](https://www.accelq.com/blog/generative-ai-testing-tools/)
- **Agent lineups conflict across marketing**
  - The Sept 2026 award release names a Universe Discover Agent, Design and Automate Agents, an Optimize Agent (self-healing), an Execution Agent, an Analyzer Agent and a Secure Data Agent. [MKT] [2026 award](https://www.accelq.com/news/accelq-named-ai-based-engineering-solution-of-the-year-2026/)
  - The agentic guide names Discovery, Automation, Analyzer and Change Analyzer agents. [MKT] [Agentic Automation guide](https://www.accelq.com/blog/agentic-automation/)
  - A comparison article says "seven AI agents". [3P] via search summary
- **Third-party views**
  - Q-GPT is described as "Plain English authoring for test logic". [3P] [Merito vendor profile](https://www.merito.com/vendors/accelq/accelq)
  - An independent roundup: "in practice most teams use it as a powerful codeless platform with AI assistance rather than agent-driven testing". [3P] [qa.tech: 12 best agentic QA tools 2026](https://qa.tech/blog/best-agentic-qa-tools-in-2026)

### Inferences
- Several documented facts together suggest generated steps are composed **from the existing model** rather than from free-form selectors:
  - Generation starts from "a chosen application".
  - Scenarios are sequences of Actions whose Origin and Destination must chain.
  - Locator-free hints are text the model can emit.
- If so, the continuity check from section 1 would act as a structural guard on AI output. **This is inference; ACCELQ does not document a grounding or hallucination check.**
- The documented human loop is the editor: generated steps land as editable statements, and test cases are "proposed" before the user saves them (see section 6). No diff or approval gate like ours is described.

### Gaps
- How Autopilot verifies a generated step's element exists (grounding): **not documented**.
- Which LLM is used and where it runs: not found.
- What "Discovery" actually crawls (live app vs wireframes): marketing only.
- No 8.x release notes surfaced, so post-7.0 documented changes are unknown.

## 6. Test data

### Takeaway
Parameters can be bound to a **Data Type** or **Data List** (finite domains). ACCELQ then generates test cases **algorithmically**, using All-Pairs for a minimal covering set or full Combinations. The user picks from the proposed list and saves.

Environment handling uses **Global Properties** with per-environment values and a "Default" fallback, plus **Run Properties** that override Global Properties by name at trigger time. Labels themselves can be parameters.

### Cited Findings
- **Generation from finite domains**
  - Parameters marked with a Data Type or Data List participate in generation, started from "Generate Test Cases" in the Test Cases tab.
  - It uses **all-pair analysis to produce the minimal set of permutations covering each parameter value**. The user selects from the proposed list and saves.
  - [DOC] [Test Case Generation for Manual Testing](https://support.accelq.com/hc/en-us/articles/360034374472-Test-Case-Generation-for-Manual-Testing)
  - When a parameter's data source is a Data Type or Data List, ACCELQ "automates the process of Test Case generation, instead of manually creating permutations". The same Scenario runs with multiple data sets. [DOC] [Support for data driven testing](https://support.accelq.com/hc/en-us/articles/115007511007-Support-for-data-driven-testing-ability-to-execute-same-Scenario-with-multiple-data-sets)
  - Recommendation: define a Data Type or Data List whenever a parameter takes a limited set of values. [DOC] [Scenarios and Test Suites](https://support.accelq.com/hc/en-us/articles/360026468412-Scenarios-and-Test-Suites)
  - Algorithmic options: All Pairs, Combinations. [DOC] [Working with Test Cases in ACCELQ](https://support.accelq.com/hc/en-us/articles/41589227364237-Working-with-Test-Cases-in-ACCELQ)
  - A Data Type is either Fixed or Variable. [MKT] [Working with Data Types and Data Lists](https://www.accelq.com/blog/working-with-data-types-and-data-lists-in-accelq/)
- **Global Properties and environments**
  - A Global Property has one value for all environments, or a value per Application Environment (for example the URL). At run time you pick the environment and values resolve from it. [DOC] [Setting up Application Environments](https://support.accelq.com/hc/en-us/articles/115010300248-Setting-up-Application-Environments)
  - "Value in 'Default' App Environment is used when a property is not explicitly defined for a given environment." [DOC] [What is a Global Property](https://support.accelq.com/hc/en-us/articles/32740252628621-What-is-a-Global-Property)
  - Run Properties set at trigger time "override the default values of Global Properties if the names match". [DOC] [Managing API Test Environments and Configurations](https://support.accelq.com/hc/en-us/articles/38191464769165-Managing-API-Test-Environments-and-Configurations-in-ACCELQ)
  - CI tools can pass Run Properties; title only. [DOC] [How do I provide Run Property information for a job executed from CI tool](https://support.accelq.com/hc/en-us/articles/360016076751-How-do-I-provide-Run-Property-information-for-a-job-executed-from-CI-tool)
  - Driver Profiles are custom driver configurations for web and mobile. [DOC] [Resources](https://support.accelq.com/hc/en-us/articles/360026494951-Resources)
- **Data flow between steps**
  - Output values can be stored in parameters for later steps. [DOC] [Recording Fundamentals](https://support.accelq.com/hc/en-us/articles/48792817708685-Recording-Fundamentals)
  - Output parameters can be passed between test cases; title only. [DOC] [Storing output parameters and passing data between different test cases](https://support.accelq.com/hc/en-us/articles/360060373051-Storing-output-parameters-and-passing-data-between-different-test-cases)
- **Synthetic data**
  - Only marketing mentions a "Secure Data Agent". [MKT] [2026 award](https://www.accelq.com/news/accelq-named-ai-based-engineering-solution-of-the-year-2026/)

### Inferences
- The combinatorial generator is **pure algorithm over declared finite domains**, with no model involved. Our DOM discovery already sees finite domains (`<select>` options, Salesforce picklist values, radio groups) and could feed an identical all-pairs generator deterministically.

### Gaps
- Synthetic data generation mechanics: not documented.
- Constraint handling in all-pairs (invalid combinations): not documented.

## 7. Assertions and verification

### Takeaway
Verification is command-based:
- **Verify** commands (for example Verify Element Text, Verify Element Exists) wait up to the element timeout and can be set to continue or abort on failure.
- **Inspection** commands return a boolean immediately.
- **Element-scoped** commands are limited to that element type; page-level commands come from the editor.

**API and DB steps can be interleaved with UI steps** in one Action (multi-modal). No visual-diff assertion was found in the docs.

### Cited Findings
- **Command names and timeouts**
  - "Verify Element Text" and "Verify Element Exists" are named as verify commands. They use the Run-modal Element Timeout, while inspection commands ("Is Web Element displayed") return immediately. [DOC] [Wait times…](https://support.accelq.com/hc/en-us/articles/360030131851-Wait-times-for-various-commands-and-UI-interactions-during-test-execution)
- **Failure action**
  - Verification commands offer "continue to execute the test" or "abort the test" (documented in the XML command docs). [DOC] [Working with XML in accelQ](https://support.accelq.com/hc/en-us/articles/360032765271-Working-with-XML-in-accelQ)
  - An unofficial cheat sheet says the generic Verify "does not abort testcase if fails". [3P] [Cheatography ACCELQ cheat sheet](https://cheatography.com/olivercha/cheat-sheets/accelq/)
  - *Partial conflict:* the default failure action is not confirmed.
- **Authoring verifications**
  - Verifications are **never recorded automatically in Fluid mode**. Add one by right-clicking an element; commands offered are "exclusive commands on the particular element type".
  - Page-level commands are inserted from the logic editor.
  - [DOC] [Recording Fundamentals](https://support.accelq.com/hc/en-us/articles/48792817708685-Recording-Fundamentals)
  - Verification guide; title only. [DOC] [Challenge 02 - Verifying information](https://support.accelq.com/hc/en-us/articles/4404642427021-Challenge-02-Verifying-information)
- **Multi-modal steps**
  - One Action or Scenario can mix web, mobile and other recorder types. Non-UI steps such as **API and database calls can be interleaved**. Playback drives the browser or device as each statement requires.
  - [DOC] [Multi-Modal Automation](https://support.accelq.com/hc/en-us/articles/48792910342797-Multi-Modal-Automation)
- **Salesforce API**
  - Salesforce API testing is documented, including OAuth 2.0 Client Credentials (REST action, `application/x-www-form-urlencoded`, `grant_type=client_credentials`). [DOC] [Automation Testing of Salesforce API (OAuth 2.0 - Client Credentials)](https://support.accelq.com/hc/en-us/articles/40586628493965-Automation-Testing-of-Salesforce-API-OAuth-2-0-Client-Credentials); [Automation testing of Salesforce API](https://support.accelq.com/hc/en-us/articles/9879082432525-Automation-testing-of-Salesforce-API)

### Inferences
- Restricting the commands offered to those valid for the element type is a schema-level constraint. Our analogue is rejecting at grounding an IR step whose action or assertion is incompatible with the discovered element's role, for example `fill` on a button or `select` on a non-listbox.

### Gaps
- Visual or screenshot comparison assertions: not found.
- Full verify command catalogue: not found.
- Soft-assert defaults: unclear.

## 8. Failure triage and reporting

### Takeaway
What is documented:
- Screenshot policies: Comprehensive, Optimal (at transition points, recommended), or On Error.
- One-click defect creation from a failed test case, pre-filled with repro steps and screenshots, into Jira, Azure or Rally (TFS was also mentioned).
- A self-healing panel in the report.
- An interactive Debug pause on element-not-found.
- A Playback Console with errors and timing.

**Automatic failure categorisation is not documented.** The "Analyzer" agent and "AI root cause analysis" are marketing claims only.

### Cited Findings
- **Screenshots**
  - Modes: Comprehensive (every interaction), Optimal (ACCELQ chooses transition points; recommended), On Error. [DOC] [Running Automation Test](https://support.accelq.com/hc/en-us/articles/115010299188-Running-Automation-Test); [Overview of Test Report](https://support.accelq.com/hc/en-us/articles/115010371148-Overview-of-Test-Report)
- **Defects**
  - The bug icon on a failed test case opens a form pre-filled with steps to reproduce and error screenshots, and creates a defect in Jira or TFS. The created Jira id is returned.
  - Jira, Azure and Rally are supported out of the box.
  - [DOC] [How to create Bugs from the Test result](https://support.accelq.com/hc/en-us/articles/115010371208-How-to-create-Bugs-from-the-Test-result); [Establishing defect traceability for Scenarios](https://support.accelq.com/hc/en-us/articles/115007532207-Establishing-defect-traceability-for-Scenarios)
- **Playback**
  - Per-statement status icons and a Playback Console that logs errors and timing. [DOC] [Playback and Validation](https://support.accelq.com/hc/en-us/articles/48792885705741-Playback-and-Validation)
- **Marketing claims**
  - "ACCELQ Manual offers AI root cause analysis for defect patterns". [MKT] [ACCELQ blog (bug-tracking tools)](https://www.accelq.com/blog/bug-tracking-tools/)
  - An "Analyzer Agent". [MKT] [2026 award](https://www.accelq.com/news/accelq-named-ai-based-engineering-solution-of-the-year-2026/)
- **Reviewer complaints**
  - Slowness on very large suites and dashboards, "limited reporting depth", and debugging that takes more effort than expected due to limited visibility. [3P] [G2 pros and cons](https://www.g2.com/products/accelq/reviews?qs=pros-and-cons); [Capterra reviews](https://www.capterra.com/p/161589/accelQ/reviews/)

### Inferences
- "Optimal" screenshots at **transition points** is a cheap, structural policy: capture when the Context changes, not on every step. We already compute screen fingerprints, so we could do the same.

### Gaps
- Video recording: not found.
- Failure categories (app bug, test bug, environment): not documented.
- What the Analyzer actually outputs: unknown.

## 9. Salesforce support

### Takeaway
**Very little Salesforce-specific UI mechanism is documented in the help centre.** What is documented:
- The modal-design guide (built on the Salesforce "New Lead" modal).
- Salesforce MFA login automation.
- Salesforce API setup and OAuth.

Claims about handling Lightning dynamic elements, iframes, Classic, Lightning, LWC, and release-aligned prebuilt assets ("ACCELQ Live") are **marketing**. Picklists, lookups, related lists, record pages, Setup iframes and Experience Cloud handling were **not found documented**.

### Cited Findings
- **Modals**: Salesforce "New Lead" modal modelling. The open-modal Action is separate from the in-modal Action, and the in-modal Action is shared to every Context that can launch it. [DOC] [Designing Contexts and Actions for modal windows](https://support.accelq.com/hc/en-us/articles/360001619091-Designing-Contexts-and-Actions-for-modal-windows)
- **MFA**: automated Salesforce login with a security code in Action logic. [DOC] [Salesforce MFA: Automated login with security code in Action logic](https://support.accelq.com/hc/en-us/articles/4404314615693-Salesforce-MFA-Automated-login-with-security-code-in-Action-logic)
- **API setup**
  - API access prerequisites: create an app, get the Consumer Key and Secret. Salesforce now prioritises External Client Apps over Connected Apps. [DOC] [Pre-Requisite Setup To Enable API Access In Salesforce](https://support.accelq.com/hc/en-us/articles/4404323583245-Pre-Requisite-Setup-To-Enable-API-Access-In-Salesforce)
  - OAuth client credentials flow. [DOC] [Salesforce API OAuth 2.0 Client Credentials](https://support.accelq.com/hc/en-us/articles/40586628493965-Automation-Testing-of-Salesforce-API-OAuth-2-0-Client-Credentials)
- **Marketing claims**
  - It handles "Salesforce dynamic elements & iframes", supports Classic, Lightning and Lightning Web Components, and ACCELQ is an ISV partner aligned to Salesforce releases. [MKT] [ACCELQ for Salesforce](https://www.accelq.com/salesforce/)
  - ACCELQ Live / "Salesforce Live" is "codeless automation assets modeled on business processes, readily available through a live link to the cloud", which "automatically updates test assets with every new vendor release". [MKT] [What is Salesforce Live](https://www.accelq.com/blog/salesforce-live-the-roi-booster/); [ACCELQ to unveil ACCELQ Live](https://www.accelq.com/events/accelq-to-unveil-accelq-live/)
- **Third-party views**
  - ACCELQ handles iframes and dynamic controls "through visual element identification". [3P] [Apex Hours](https://www.apexhours.com/automate-salesforce-tests-with-codeless-ai/)
  - Shadow DOM is handled automatically "in most cases"; self-healing adapts to UI changes. [3P] [Testdino comparison 2026](https://testdino.com/blog/salesforce-test-automation-tools-compared)
  - "Some dynamic UI elements still remain difficult to automate"; custom or dynamic scenarios "sometimes require workarounds". [3P] [rfp.wiki](https://www.rfp.wiki/artificial-intelligence/ai-augmented-software-testing-tools/accelq/functionize); [ContextQA comparison](https://contextqa.com/comparison/contextqa-vs-accelq/)
  - Both sources are competitor or aggregator pages.

### Inferences
- ACCELQ's Salesforce advantage, as documented, is mostly **modelling discipline**: modals as shared Actions, plus locator-free labels that avoid Lightning's runtime ids. API-based setup through Salesforce REST is the other piece. No documented Lightning-specific locator magic was found.

### Gaps
- Picklist (lightning-combobox) and lookup handling: not documented.
- Related lists, record-page tabs, Setup iframes, Experience Cloud, and Classic vs Lightning switching: not documented.
- How ACCELQ Live assets are kept in sync with seasonal releases: marketing only.
- No independent benchmark of these claims was found.

## 10. Execution architecture

### Takeaway
A **Local Agent** on the customer's machine makes an **outbound-only pull** connection to the ACCELQ platform, fetches instructions and reports results. Browsers run locally by default, or on a cloud grid configured in `agent.properties`. A **Distributed Agent** for parallel runs arrived in 6.2 (Jun 2024). Authoring uses a Web Recorder with auto-playback and an interactive Playback mode.

### Cited Findings
- **Local Agent**
  - "Outbound-only 'pull' connection to the ACCELQ Platform to fetch test instructions and report results." [DOC] [A Guide to ACCELQ's Hosting and Deployment Models](https://support.accelq.com/hc/en-us/articles/38063223940621-A-Guide-to-ACCELQ-s-Hosting-and-Deployment-Models)
  - Browsers and devices are invoked locally by default. Cloud providers are set in `agent.properties`: Local, Browser Stack, Sauce Labs, Perfecto, LambdaTest, HeadSpin, Digital.ai. [DOC] [Configuring Local Agent properties](https://support.accelq.com/hc/en-us/articles/4404554006541-Configuring-Local-Agent-properties)
  - Agent 7.0 (16 Feb 2025): web driver optimisation, an Ubuntu 18 CLI fix, MX mobile execution. Agent 6.2 (06 Jun 2024): Distributed Agent for parallel execution. [REL] [Release Notes: ACCELQ Local Agent](https://support.accelq.com/hc/en-us/articles/34973095458701-Release-Notes-ACCELQ-Local-Agent)
  - 5.1: mobile tests can use an external device provider while browser tests run locally. [REL] [What's new in Release 5.1](https://support.accelq.com/hc/en-us/articles/4422377259021-What-s-new-in-Release-5-1)
  - BrowserStack: "execution and results workflows remain the same". [3P] [BrowserStack docs](https://www.browserstack.com/docs/automate/selenium/accelq)
- **Recorder**
  - Statements appear in the Logic Editor as you work. With Auto Playback, each statement runs as soon as it is completed.
  - Playback runs statements against the live app without a formal job. Recording pauses during playback.
  - [DOC] [Recording Fundamentals](https://support.accelq.com/hc/en-us/articles/48792817708685-Recording-Fundamentals); [Playback and Validation](https://support.accelq.com/hc/en-us/articles/48792885705741-Playback-and-Validation); [Web Recorder Overview](https://support.accelq.com/hc/en-us/articles/48792895607437-Web-Recorder-Overview)
- **Cross-browser**: a cross-browser and cross-platform capabilities article exists; title only. [DOC] [Cross-Browser and Cross-Platform Testing Capabilities](https://support.accelq.com/hc/en-us/articles/38098795454861-ACCELQ-Cross-Browser-and-Cross-Platform-Testing-Capabilities)

### Inferences
- **Auto Playback**, where each statement is executed the moment it is authored, is "verify by running" at authoring time. It mirrors this repo's own rule that a generated Playwright expression isn't verified until it has run (CLAUDE.md, D-19).

### Gaps
- The underlying driver (Selenium or Playwright) is not stated in the excerpts seen.
- Cloud-hosted ACCELQ execution grid details were not retrieved.

## Adoptable techniques for our pipeline

Each item names the ACCELQ source it is based on and where it would land in this repo. Per `CLAUDE.md`, each would ship behind an env flag defaulting OFF, and each check is **structural** (role, screen, element), never a regex over model prose.

1. **Origin/Destination continuity check on the IR, with a "Missing Step" outcome.** *Source: [Selecting steps while building a Scenario](https://support.accelq.com/hc/en-us/articles/360060372771-Selecting-steps-while-building-a-Scenario), [Defining Destination Context](https://support.accelq.com/hc/en-us/articles/360021044992-Defining-Destination-Context-for-an-Action).*
   - Each grounded step already resolves to a screen (task "Ground each step against its own screen in toIR").
   - Add a deterministic check in `ir.ts` grounding. If step N+1's target screen is neither step N's screen nor a known destination of step N's control in `screenMap.ts` edges, reject the IR with a structured "missing step" error instead of letting the run discover it.
   - Treat `assert` and `wait` steps as **"Current Context"**: they must not change the screen fingerprint.
2. **Multi-destination edges with explicit branch selection.** *Source: [Examples: Multiple Destination Contexts](https://support.accelq.com/hc/en-us/articles/360021308872-Examples-Multiple-Destination-Contexts-for-Action).*
   - Let a screen-map edge record several `to` screens. Examples: login leads to home, MFA, or stays on login with an error. Salesforce Save leads to a record page or stays on the modal with a validation error.
   - When a case uses such a control, require the IR to state which destination it expects, and assert it (URL or screen fingerprint) after the step. A negative test then legitimately expects "stay on Current Context".
3. **Per-screen synchronisation predicate, chosen by uniqueness and lateness.** *Source: [Setting up Context Synchronization](https://support.accelq.com/hc/en-us/articles/360023724512-Setting-up-Context-Synchronization), [Guidelines for setting up Synchronization](https://support.accelq.com/hc/en-us/articles/115005242267-Guidelines-for-setting-up-Synchcronization).*
   - For each captured screen, pick a sync element: a role+name present in this screen and **absent from every other screen in the map**, preferring one that appeared last during capture (we have settle-wait timing).
   - Fall back to title or heading text.
   - The generator emits `await expect(<sync>).toBeVisible()` before the first action on a newly reached screen. This replaces fixed sleeps and gives Salesforce Lightning's late-rendering record pages a principled wait.
   - Per `CLAUDE.md`/D-19, run the emitted expression once against synthetic HTML before trusting it.
4. **Anchor text: a region-scoping second text on `Target`.** *Source: [Locator-free Element Identification](https://support.accelq.com/hc/en-us/articles/13031514925453-Locator-free-Element-Identification-for-Web-Applications), [Best Practices for Locator-Free](https://support.accelq.com/hc/en-us/articles/18857862819981-Best-Practices-for-utilizing-Locator-Free-Elements).*
   - Add an optional `anchor` to `Target` in `src/schema/ir.ts`: a section heading, fieldset legend, card title or Salesforce section label such as "Address Information".
   - Grounding resolves it **from DOM discovery** (the nearest container whose heading matches) and copies the container's CSS into a code-written field, never model-written, like `css`/`frame`.
   - This resolves duplicate labels such as "Street" under Billing vs Shipping without a fragile `nth`.
5. **Label match operators: equals-ignore-case, startsWith, contains, regex.** *Source: [Troubleshooting issues with Locator-free…](https://support.accelq.com/hc/en-us/articles/19052862960525-Troubleshooting-issues-with-Locator-free-element-identification).*
   - Add an optional `nameMatch: "exact" | "prefix" | "contains" | "regex"`.
   - Ground it deterministically: the pattern must match the discovered element's accessible name **and match exactly one element on that screen**. This gives dynamic labels ("Cases (12)", "Submit Order/Purchase", record numbers) a verified identity.
6. **Match-count gate as an explicit grounding invariant.** *Source: [Element Explorer](https://support.accelq.com/hc/en-us/articles/360026192152-Setting-up-Element-Identification-with-Element-Explorer).*
   - When grounding, compute how many AppModel elements on that screen the final target (role/name/anchor/nth) matches. Require exactly 1, or require `nth` to be present when there are more.
   - Surface the count in `04-ir.json` and the editor, as Explorer's footer does.
7. **Visual index as an alternative to DOM-order `nth`.** *Source: [Locator-free…](https://support.accelq.com/hc/en-us/articles/13031514925453-Locator-free-Element-Identification-for-Web-Applications) ("physical location… from the upper left").*
   - Live discovery can record bounding boxes. Where DOM order and visual order disagree (CSS grid/flex order, Lightning two-column layouts), store which ordering `nth` refers to and make the runtime resolver use the same one.
   - The generator and `targetResolver.ts` would both need it; see TD-07 on their drift.
8. **Repeat element and container ("family") scoping for rows and cards.** *Source: [Working with family of dynamic, related fields](https://support.accelq.com/hc/en-us/articles/360002756632-Working-with-family-of-dynamic-related-fields-anchor-or-container-element), [Working with HTML tables](https://support.accelq.com/hc/en-us/articles/360029848751-Working-with-HTML-tables-in-accelQ), [Dynamically finding a row…](https://support.accelq.com/hc/en-us/articles/360043109051-Dynamically-finding-a-row-in-html-table-with-matching-criteria).*
   - Add `within: { role: "row" | "listitem" | "article", hasText }` so "click Edit in the row whose Name is Acme" is expressible and groundable.
   - Matching the row by a column's text maps to Salesforce list views and related lists (lightning-datatable rows).
9. **Self-heal exclusions for "absence" steps.** *Source: [Self Healing - Comprehensive approach](https://support.accelq.com/hc/en-us/articles/4420289421709-Self-Healing-Comprehensive-approach-to-adaptive-element-identification).*
   - In `deterministicHeal.ts`/`heal.ts`, never heal a step whose assertion is `hidden`/`disabled`, or a wait-for-disappear. A healed target there could make a real regression pass.
   - Mark such steps "heal skipped (presence-doubtful)" in the report.
10. **Healing report with per-element flakiness history, never silently persisted.** *Source: same article ("visual interface… trace flakiness", "calibrates… from various test runs"); [Playback and Validation](https://support.accelq.com/hc/en-us/articles/48792885705741-Playback-and-Validation).*
    - Record each heal (old target, new target, `TargetDiff`) per screen and control in the screen map, with a counter.
    - Show it in `htmlReport.ts`. Offer "save back" through the existing D-27 diff and approval path, not automatically.
    - Elements healed repeatedly get flagged as unstable.
11. **Two-tier identity: semantic primary, attribute fallback, both visible.** *Source: [Locator Options…](https://support.accelq.com/hc/en-us/articles/17598987289997-Locator-Options-for-Element-Identification-in-Web-Applications), [Release 6.2](https://support.accelq.com/hc/en-us/articles/26893382270093-ACCELQ-6-2-Unleashing-Next-Gen-Automation-Efficiency) (map locator-free to Smart Locator for troubleshooting).*
    - Keep role/name as primary and code-written `css` as fallback.
    - In the report, show which tier actually resolved each step at runtime, so drift between them is visible.
12. **Abstract (ungrounded) elements with a reconcile step.** *Source: [Working with Abstract Elements](https://support.accelq.com/hc/en-us/articles/360023982131-Working-with-Abstract-Elements), [Reconciling Element Selectors when UI is updated](https://support.accelq.com/hc/en-us/articles/360038632132-Reconciling-Element-Selectors-when-application-UI-is-updated).*
    - Allow an edited case (`caseEdit.ts`) to keep a step whose target is not yet discovered, rendered distinctly (ACCELQ's orange), and **blocked from running** until reconciled against a fresh capture.
    - On a screen re-capture, auto-map unchanged elements by role and name, and present only the rest for human mapping. That is ACCELQ's "Save As" flow.
13. **Multiple Views per screen, not new screens.** *Source: [Why do I ever need multiple Views for a Context?](https://support.accelq.com/hc/en-us/articles/360000692332-Why-do-I-ever-need-multiple-Views-for-a-Context).*
    - Controls revealed by an in-page click (date picker, "Advanced", Salesforce inline-edit pencil) attach to the **same** screen as an extra view. Capture them only when a case needs them, and never split on data differences.
    - This matches and justifies the loose same-screen merge in `screens.ts`.
14. **Modal modelling rule for Salesforce.** *Source: [Designing Contexts and Actions for modal windows](https://support.accelq.com/hc/en-us/articles/360001619091-Designing-Contexts-and-Actions-for-modal-windows).*
    - Treat a modal reachable from many pages (New Record, global actions) as its own screen, with an "open" edge from each origin.
    - Treat a modal tied to one page as a view of that page.
    - Ground in-modal steps against the modal's screen only (`DIALOG_SELECTOR` scope already exists in `targetResolver.ts`).
15. **Wait semantics split: verify waits, inspection doesn't.** *Source: [Wait times for various commands…](https://support.accelq.com/hc/en-us/articles/360030131851-Wait-times-for-various-commands-and-UI-interactions-during-test-execution), [Setting up synchronization in test logic](https://support.accelq.com/hc/en-us/articles/360000694612-Setting-up-synchronization-in-test-logic).*
    - Give `wait` explicit sub-kinds (appear, disappear, enabled, disabled) with their own timeout.
    - Keep assertions on the element timeout.
    - Defaults to consider: element 30 s, page 60 s.
16. **"Action Insights"-style deterministic lint.** *Source: [What's new in Release 7.0](https://support.accelq.com/hc/en-us/articles/33991400145165-What-s-new-in-Release-7-0).*
    - Flag fixed-duration `wait` steps, and steps on a new screen with no sync predicate. Suggest the condition wait derived from item 3. Pure code, no model.
17. **Deterministic all-pairs data generation from discovered finite domains.** *Source: [Test Case Generation for Manual Testing](https://support.accelq.com/hc/en-us/articles/360034374472-Test-Case-Generation-for-Manual-Testing), [Working with Test Cases](https://support.accelq.com/hc/en-us/articles/41589227364237-Working-with-Test-Cases-in-ACCELQ).*
    - Picklist and select options and radio groups discovered in the AppModel are finite domains.
    - Generate a minimal all-pairs set in code and **propose** it. The user picks, as in ACCELQ, rather than asking Gemini to enumerate combinations.
18. **Environment-scoped properties with Default fallback and run-time override.** *Source: [What is a Global Property](https://support.accelq.com/hc/en-us/articles/32740252628621-What-is-a-Global-Property), [Managing API Test Environments](https://support.accelq.com/hc/en-us/articles/38191464769165-Managing-API-Test-Environments-and-Configurations-in-ACCELQ).*
    - Resolve `${env:...}` references by: run override, then per-environment value, then Default.
    - Allow a label or anchor to be a property reference (ACCELQ allows parameters as labels) for per-org Salesforce labels.
19. **Screenshot policy "at transition points".** *Source: [Running Automation Test](https://support.accelq.com/hc/en-us/articles/115010299188-Running-Automation-Test).*
    - Capture when the screen fingerprint changes, plus on error. This is cheaper than every step and more useful than error-only.
20. **API-assisted Salesforce data setup interleaved with UI steps.** *Source: [Multi-Modal Automation](https://support.accelq.com/hc/en-us/articles/48792910342797-Multi-Modal-Automation), [Salesforce API OAuth 2.0 Client Credentials](https://support.accelq.com/hc/en-us/articles/40586628493965-Automation-Testing-of-Salesforce-API-OAuth-2-0-Client-Credentials).*
    - Create or clean test records via Salesforce REST, behind a flag and with credentials held in memory only (rule 5). The UI test then starts on a known record page instead of driving creation through Lightning forms.
21. **Defect hand-off pre-filled from the run.** *Source: [How to create Bugs from the Test result](https://support.accelq.com/hc/en-us/articles/115010371208-How-to-create-Bugs-from-the-Test-result).*
    - From a failed case, prefill a Jira or Azure issue with the step text (`stepText.ts` format), failing screenshot and classifier verdict, via a new route (rule 1).
22. **Author-time auto-playback.** *Source: [Recording Fundamentals](https://support.accelq.com/hc/en-us/articles/48792817708685-Recording-Fundamentals).*
    - In the step editor, optionally replay each edited step on save (we have `replay.ts`). This catches ungroundable edits immediately rather than at run time.
