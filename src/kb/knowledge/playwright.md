## Prefer role-based locators
Use `page.getByRole('button', { name: 'Submit' })` over CSS selectors or XPath — role-based locators are more resilient to markup changes and mirror how assistive tech identifies elements.

## Auto-waiting, but assert explicitly
Playwright actions auto-wait for actionability, but still use explicit `expect(locator).toBeVisible()` / `toHaveText()` assertions after actions rather than assuming success.

## Network idle vs load state pitfalls
`waitForLoadState('networkidle')` can hang on pages with polling/websockets. Prefer waiting for a specific element or response instead when the page has persistent background requests.

## Handling dynamic content
For content that loads asynchronously (search results, infinite scroll), assert on the eventual state with Playwright's built-in retrying `expect`, not a manual timeout.

## Isolating test state with contexts
Use a fresh `browserContext` (or `storageState`) per test for login/session tests, so one test's cookies/localStorage don't leak into another.

## Locating within iframes and shadow DOM
Use `page.frameLocator()` for iframes; Playwright locators pierce open shadow DOM automatically, but closed shadow roots need a different strategy (component test or app-specific hook).