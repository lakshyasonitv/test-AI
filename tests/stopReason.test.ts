import { describe, it, expect } from "vitest";
import { stopReason, cleanName } from "../src/stages/stopReason.js";

/**
 * "Why it stopped" for the downloaded report. Every error below is copied (trimmed) from two real
 * Salesforce run reports, 2026-11-02 c64582ea and 2026-11-03 da7587e8, where the report showed only
 * Playwright's raw text and, for the covered button, the wrong reason ("exceeded its timeout").
 */

// Report 1, cases 2 and 3: the search box's dropdown sat on top of the Search button.
const COVERED_BY_SEARCH_BOX = `TimeoutError: locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('button[aria-label="Search"]').first()
  - locator resolved to <button id="276:0" type="button" aria-label="Search" class="slds-button search-button">…</button>
  - attempting click action
  - <input part="input" type="search" id="input-163" maxlength="100" class="slds-input" placeholder="Search..." aria-controls="suggestionsList-158"/> from <div data-aura-rendered-by="477:0;p" class="DESKTOP uiContainerManager">…</div> subtree intercepts pointer events
  - retrying click action`;

// Report 1, case 5: covered by a <div> with no name.
const COVERED_BY_DIV = `TimeoutError: locator.click: Timeout 10000ms exceeded.
Call log:
  - locator resolved to <button class="slds-button" aria-description="Ask your admin">…</button>
  - <div data-aura-rendered-by="1093:0" class="slds-col slds-var-p-right_small">…</div> from <div class="DESKTOP uiContainerManager">…</div> subtree intercepts pointer events`;

// Report 1, case 1: the Setup button's check found nothing.
const NOT_FOUND_ASSERT = `Error: Timed out 10000ms waiting for expect(locator).toBeVisible()
Locator: getByRole('button', { name: 'SetupOpens in a new tab', exact: true }).and(locator(':visible'))
Expected: visible
Received: <element(s) not found>
Call log:
  - expect.toBeVisible with timeout 10000ms`;

// Report 2, case 1: waited for Setup to appear, it never resolved.
const NOT_FOUND_WAIT = `TimeoutError: locator.waitFor: Timeout 2000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'SetupOpens in a new tab', exact: true }) to be visible
   at C:\\Users\\Some One\\test-AI\\runs\\x\\generated\\test.spec.ts:186:14`;

describe("stopReason", () => {
  it("names the thing that was covering a button (the reason the report used to miss)", () => {
    expect(stopReason({
      status: "failed", errorText: COVERED_BY_SEARCH_BOX, failedStepTitle: "Click 'Search'",
      target: { role: "button", name: "Search" },
    })).toBe(`The "Search" button was on the page, but the "Search..." box was on top of it, so the click never landed.`);
  });

  it("says 'another part of the page' when the cover has no name", () => {
    expect(stopReason({ status: "failed", errorText: COVERED_BY_DIV, failedStepTitle: "Click 'Help'" }))
      .toBe(`The "Help" was on the page, but another part of the page was on top of it, so the click never landed.`);
  });

  it("says the element was never found, with the screen-reader hint removed from its name", () => {
    const why = stopReason({
      status: "failed", errorText: NOT_FOUND_ASSERT,
      failedStepTitle: "Assert 'SetupOpens in a new tab' is visible",
      target: { role: "button", name: "SetupOpens in a new tab" },
    });
    expect(why).toBe(`The "Setup" button was never found on the page.`);
  });

  it("reads a timed-out wait with no 'resolved to' as never found", () => {
    expect(stopReason({ status: "failed", errorText: NOT_FOUND_WAIT,
      failedStepTitle: "Click 'SetupOpens in a new tab'" }))
      .toBe(`The "Setup" was never found on the page.`);
  });

  it("says found-but-never-ready when the element was there", () => {
    const e = `TimeoutError: locator.click: Timeout 5000ms exceeded.
  - locator resolved to <button>Save</button>
  - waiting for element to be visible, enabled and stable`;
    expect(stopReason({ status: "failed", errorText: e, target: { role: "button", name: "Save" } }))
      .toBe(`The "Save" button was found, but it never became ready within 5 seconds.`);
  });

  it("explains a failed value check with what was expected and what the page had", () => {
    const e = `Error: Timed out 10000ms waiting for expect(locator).toHaveText(expected)
Expected string: "Order placed"
Received string: "Payment failed"`;
    expect(stopReason({ status: "failed", errorText: e }))
      .toBe(`The check failed: expected "Order placed", but the page had "Payment failed".`);
  });

  it("covers hidden, duplicate, network and whole-test timeout", () => {
    expect(stopReason({ status: "failed", errorText: "locator.click: element is not visible", target: { name: "Menu" } }))
      .toContain("hidden or disabled");
    expect(stopReason({ status: "failed", errorText: "Error: strict mode violation: resolved to 3 elements", target: { name: "Edit" } }))
      .toContain("More than one element matched");
    expect(stopReason({ status: "failed", errorText: "page.goto: net::ERR_NAME_NOT_RESOLVED at https://x" }))
      .toContain("ERR_NAME_NOT_RESOLVED");
    expect(stopReason({ status: "failed", errorText: "Test timeout of 50000ms exceeded." }))
      .toBe("The whole test ran out of time before it finished.");
  });

  it("explains blocked and cut-short cases from what was saved", () => {
    expect(stopReason({ status: "blocked", blockedBy: "a verification code was sent by email" }))
      .toBe("Couldn't finish: a verification code was sent by email.");
    expect(stopReason({ status: "blocked" })).toContain("Couldn't finish");
    const cut = stopReason({ status: "truncated_no_assertion", stepCount: 4, truncationNote: "no element named 'New'" });
    expect(cut).toContain("Nothing was checked");
    expect(cut).toContain("after step 4");
    expect(cut).toContain("Recorded reason: no element named 'New'");
    expect(stopReason({ status: "truncated", stepCount: 3 })).toContain("Only part of the test ran");
  });

  it("says nothing when there is nothing sure to say", () => {
    expect(stopReason({ status: "passed" })).toBeNull();
    expect(stopReason({ status: "failed" })).toBeNull();
    expect(stopReason({ status: "failed", errorText: "Something unusual happened" })).toBeNull();
  });

  it("cleanName strips only the screen-reader hint", () => {
    expect(cleanName("SetupOpens in a new tab")).toBe("Setup");
    expect(cleanName("Help (Opens in a new window)")).toBe("Help");
    expect(cleanName("Open new tab")).toBe("Open new tab");
  });
});
