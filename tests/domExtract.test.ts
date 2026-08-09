import { describe, it, expect } from "vitest";
import { extractCrawlResponse } from "../src/stages/domExtract.js";

// Regression: an <a>/<button>/<input>/<select>/<textarea> that ALSO carries an explicit
// `role` attribute was extracted twice — once by the tag-based loop, once by the
// role-based `[role]` loop — under two different, non-colliding dedup keys. That produced
// duplicate interactive_elements with identical role+name, which downstream becomes a
// duplicate AppModel element and a Playwright "strict mode: matched 2 elements" failure.
describe("extractCrawlResponse — interactive element dedup", () => {
  it("does not double-emit an <a> that also carries an explicit role attribute", () => {
    const html = `<html><body><a href="/cart" role="tab">Cart</a></body></html>`;
    const result = extractCrawlResponse(html, "https://example.com", 200);
    const matches = result.interactive_elements.filter((e) => e.name === "Cart");
    expect(matches.length).toBe(1);
  });

  it("still extracts a role-only element with no interactive tag exactly once", () => {
    const html = `<html><body><div role="tab">Overview</div></body></html>`;
    const result = extractCrawlResponse(html, "https://example.com", 200);
    const matches = result.interactive_elements.filter((e) => e.name === "Overview");
    expect(matches.length).toBe(1);
  });
});

// Regression for the learnvibes Add-New-user modal (probed live 2026-08-08): its fields are
// `<div>Full Name</div><input>` — no for/id pair, no wrapping <label>, no aria-label, no
// placeholder, no name attribute, and inline styles so no usable class either. The accname
// chain found nothing, deriveElementName found nothing, and the control was dropped as
// "genuinely unaddressable": a 49-element page model containing neither of the two inputs the
// test needed to fill.
describe("extractCrawlResponse — proximity-labelled form controls", () => {
  const modal = `<html><body><div>
    <div><div>Full Name</div><input type="text"></div>
    <div><div>Email</div><input type="email"></div>
    <div><div>Role</div><select><option>Learner</option><option>Trainer</option></select></div>
  </div></body></html>`;

  it("names an anonymous input from the text beside it instead of dropping it", () => {
    const r = extractCrawlResponse(modal, "https://example.com", 200);
    const names = r.interactive_elements.map((e) => e.name);
    expect(names).toContain("Full Name");
    expect(names).toContain("Email");
  });

  it("marks a proximity-inferred name as such — it is not the DOM's accessible name", () => {
    const r = extractCrawlResponse(modal, "https://example.com", 200);
    const fullName = r.interactive_elements.find((e) => e.name === "Full Name");
    expect(fullName?.name_from_proximity).toBe(true);
  });

  // A <select>'s text() is every option concatenated ("Select...LearnerTrainer"), which is
  // never a name anyone would target by — the proximity label must win over it.
  it("prefers the adjacent label over a select's concatenated option text", () => {
    const r = extractCrawlResponse(modal, "https://example.com", 200);
    const sel = r.interactive_elements.find((e) => e.tag === "select");
    expect(sel?.name).toBe("Role");
    expect(sel?.role).toBe("combobox");
  });

  // Inference must never override a name the DOM genuinely provides.
  it("does not override a real accessible name with nearby text", () => {
    const html = `<html><body><div><div>Nearby</div>
      <input type="text" placeholder="you@example.com"></div></body></html>`;
    const r = extractCrawlResponse(html, "https://example.com", 200);
    const input = r.interactive_elements.find((e) => e.tag === "input");
    expect(input?.name).toBe("you@example.com");
    expect(input?.name_from_proximity).toBeFalsy();
  });

  it("fills forms[].fields[].label from the same inference", () => {
    const html = `<html><body><form>
      <div><div>Full Name</div><input type="text"></div>
    </form></body></html>`;
    const r = extractCrawlResponse(html, "https://example.com", 200);
    expect(r.forms[0].fields[0].label).toBe("Full Name");
  });

  // Caught end-to-end on the learnvibes login page: its inputs DO have placeholders, so they
  // already had accessible names — but inferring a label for them too emitted the same control
  // twice, once as `textbox "you@thinkvibes.com"` (interactive path, placeholder) and once as
  // `textbox "Email"` (forms path, inferred label, which crawlResponseToAppModel ranks ABOVE
  // placeholder). The IR then targeted "Email", a name the DOM does not have, and login broke.
  it("does not infer a form label for a field that already has a placeholder", () => {
    const html = `<html><body><form>
      <div><label>Email</label><input type="email" placeholder="you@example.com"></div>
    </form></body></html>`;
    const r = extractCrawlResponse(html, "https://example.com", 200);
    expect(r.forms[0].fields[0].label).toBe("");
  });
});
