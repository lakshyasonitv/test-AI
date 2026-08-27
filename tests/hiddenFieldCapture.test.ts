import { describe, it, expect } from "vitest";
import { extractCrawlResponse } from "../src/stages/domExtract.js";

/**
 * TD-64 — a hidden input's value must never be recorded at all.
 *
 * TD-62 and TD-63 filtered hidden inputs out of the two PROMPTS. Neither could reach the run
 * artifacts: `02-appmodel.json` and `events.ndjson` record the FULL AppModel, and `runs/` is served
 * publicly (TD-14). On a real crawl of amazon.in a live `anti-csrftoken-a2z` value reached both
 * files — 2.2 MB and 2.1 MB respectively — carried by the `discovery` / `completed` event.
 *
 * It landed there through TWO routes, which is why this fixes two lines:
 *
 *   1. `forms[].fields[].value`, straight from the `value` attribute
 *   2. `elements[].name` — the accessible-name chain fell through to `attr($el, "value")`, so the
 *      element was "named" after its own token. One such element was recorded `visible: true`,
 *      so a visibility check alone would not have caught it either.
 *
 * `scrubServedSecrets` cannot help here and extending it would not have worked: it redacts KNOWN
 * secret values — the operator's TEST_USERNAME / TEST_PASSWORD. A CSRF token comes from the site
 * under test and is on no list to redact against. The only durable place to stop it is capture.
 *
 * Verified before changing it that nothing downstream reads a hidden field's value:
 * `credentials.ts` reads `inputType`/`name`/`placeholder`/`label`/`id`, `ir.ts`'s
 * `formIndicesForName` reads `label`/`name`/`placeholder`. No consumer reads `.value`.
 */

const CSRF = "hEj/Wh8642+o8zAEP15lt9A5gFAdyyTAqoNqg9Fa9jHD";

const HTML = `<!doctype html><html><body>
  <form action="/signin" method="POST">
    <input type="hidden" name="anti-csrftoken-a2z" value="${CSRF}">
    <input type="hidden" name="appAction" value="SIGNIN_CLAIM_COLLECT">
    <input type="hidden" name="metadata1" value="true">
    <label for="email">Email</label>
    <input type="email" id="email" name="email" placeholder="you@example.com" value="">
    <input type="password" name="password" placeholder="Password">
    <button type="submit">Sign In</button>
  </form>
</body></html>`;

const crawl = () => extractCrawlResponse(HTML, "https://x.test/signin", 200);

describe("TD-64 — hidden field values are never captured", () => {
  it("records an empty value for a hidden input, not the token", () => {
    const hidden = crawl().forms.flatMap((f: any) => f.fields)
      .filter((f: any) => f.input_type === "hidden");
    expect(hidden.length).toBe(3);
    for (const f of hidden) expect(f.value).toBe("");
  });

  it("keeps the hidden field's NAME, which is harmless and identifies the form", () => {
    const names = crawl().forms.flatMap((f: any) => f.fields)
      .filter((f: any) => f.input_type === "hidden").map((f: any) => f.name);
    expect(names).toContain("anti-csrftoken-a2z");
  });

  it("still records values for fields a test can act on", () => {
    const visible = crawl().forms.flatMap((f: any) => f.fields)
      .filter((f: any) => f.input_type !== "hidden");
    // The real fields survive with their labels and placeholders intact.
    expect(visible.map((f: any) => f.name)).toEqual(expect.arrayContaining(["email", "password"]));
    expect(visible.find((f: any) => f.name === "email")?.placeholder).toBe("you@example.com");
  });

  it("never names an element after a hidden input's value", () => {
    // The accname chain used to fall through to attr($el,"value"). A hidden input is not in the
    // accessibility tree at all, so it has no accessible name to derive.
    const c: any = crawl();
    const named = JSON.stringify([c.interactive_elements ?? [], c.links ?? [], c.buttons ?? []]);
    expect(named).not.toContain(CSRF);
    expect(named).not.toContain("SIGNIN_CLAIM_COLLECT");
  });

  it("leaves every STRUCTURED field of the crawl free of the token", () => {
    // Everything that feeds the AppModel's structured shape — the parts a prompt or a locator is
    // ever built from.
    const c: any = crawl();
    const structured = JSON.stringify({
      forms: c.forms, links: c.links, buttons: c.buttons, headings: c.headings,
      interactive_elements: c.interactive_elements, navigation: c.navigation,
      accessibility: c.accessibility, markdown: c.markdown,
    });
    expect(structured).not.toContain("hEj/Wh86");
    expect(structured).not.toContain("SIGNIN_CLAIM_COLLECT");
  });

  it("KNOWN REMAINING ROUTE: cleaned_html still carries it — TD-65, not this fix", () => {
    // `cleaned_html` is the raw sanitised page, so it contains value="..." verbatim and no
    // field-level fix can reach it. It is never sent to any prompt (neither toLiteModel nor
    // toMicroModel emits it) but it IS persisted into 02-appmodel.json, which runs/ serves
    // publicly — 1,791 KB of a 2,139 KB artifact on the amazon run, with zero readers anywhere
    // in the codebase.
    //
    // Asserted as still-present deliberately, the same way TD-63's gap was pinned: this line
    // fails when TD-65 lands, which is the signal to flip it.
    expect(JSON.stringify(crawl().cleaned_html)).toContain(CSRF);
  });
});
