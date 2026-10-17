import { describe, it, expect } from "vitest";
import { groundingError, redirectPostLoginNavigate } from "../src/stages/ir.js";
import { requestValues, stepsMissingValues } from "../src/stages/requestValues.js";

/**
 * Three fixes from the 2026-10-16 local test loop, each pinned to the run that found it.
 *   TD-139  the request's values must reach the compiled steps (Salesforce primary case)
 *   TD-140  after the login prefix, a navigate to the login page goes to where the login landed
 *   TD-141  a step naming an element by its exact test id / id grounds to that one element
 */

const meta = { feature: "f", title: "t", priority: "high", sourcePrompt: "", baseUrl: "https://www.saucedemo.com" };

describe("TD-139 stepsMissingValues", () => {
  const request = "Click Explore Projects, then View Project, then Select for EOI on an available unit, then Express Interest. " +
    "Fill the 3-screen form with valid test data: Self Use as purpose, Buying Timeline \"Later\", Preferred Project \"The Sanctuary\", " +
    "Preferred Areas \"Abu Dhabi\", Preferred Unit Type \"Office\". Submit and check that \"Thank You\" is shown.";
  const theCase = {
    steps: [
      "Click 'Explore Projects', then 'View Project', then 'Select for EOI', then 'Express Interest'.",
      "Click 'Self Use', choose 'Later' in 'Buying Timeline', click 'Next'.",
      "Choose 'The Sanctuary' in 'Preferred Project', 'Abu Dhabi' in 'Preferred Areas', 'Office' in 'Preferred Unit Type', click 'Submit'.",
    ],
    expected: "'Thank You' is shown.",
  };
  const click = (name: string) => ({ action: "click", target: { role: "button", name } });
  const select = (name: string, value: string) => ({ action: "select", target: { role: "combobox", name }, value });
  const head = [click("Explore Projects"), click("View Project"), click("Select for EOI"), click("Express Interest")];

  it("run 06-16-25: one form screen then 'Thank You' — the screen-2/3 values are reported", () => {
    const steps = [...head, click("Self Use"), click("Next"), { action: "assert", target: { text: "Thank You" }, assertion: "visible" }];
    const lost = stepsMissingValues(steps, theCase, requestValues(request));
    for (const v of ["Later", "The Sanctuary", "Abu Dhabi", "Office", "Buying Timeline", "Preferred Unit Type"]) expect(lost).toContain(v);
    expect(lost).not.toContain("Self Use");
    expect(lost).not.toContain("Thank You");
  });

  it("the whole flow carries every value: nothing reported", () => {
    const steps = [...head, click("Self Use"), select("Buying Timeline", "Later"), click("Next"),
      select("Preferred Project", "The Sanctuary"), select("Preferred Area(s)", "Abu Dhabi"), select("Preferred Unit Type", "Office"),
      click("Submit"), { action: "assert", target: { text: "Thank You!" }, assertion: "visible" }];
    expect(stepsMissingValues(steps, theCase, requestValues(request))).toEqual([]);
  });

  it("a false pass that asserted a URL instead of 'Thank You' is reported (run 18-02-40)", () => {
    const steps = [...head, click("Self Use"), select("Buying Timeline", "Later"), select("Preferred Project", "The Sanctuary"),
      select("Preferred Areas", "Abu Dhabi"), select("Preferred Unit Type", "Office"), click("Submit"),
      { action: "assert", target: { url: "project-details" }, value: "project-details", assertion: "url_contains" }];
    expect(stepsMissingValues(steps, theCase, requestValues(request))).toEqual(["Thank You"]);
  });

  it("a value the case itself does not carry is not demanded", () => {
    const steps = [...head, click("Self Use")];
    const lost = stepsMissingValues(steps, { steps: ["Click 'Explore Projects', 'View Project', 'Select for EOI', 'Express Interest', 'Self Use'."], expected: "" }, requestValues(request));
    expect(lost).toEqual([]);
  });
});

describe("TD-140 redirectPostLoginNavigate", () => {
  const auth = {
    status: "authenticated", url: "https://www.saucedemo.com/inventory.html", loginUrl: "https://www.saucedemo.com/",
    loginSteps: [{ action: "fill", css: "#user-name", credential: "username" }],
  } as any;
  const prefix = [{ id: "auth-0", action: "navigate", target: { url: auth.loginUrl } }, { id: "auth-1", action: "click", target: { css: "#login-button" } }] as any[];

  it("run 08-34-26: navigate '/' after signing in goes to /inventory.html", () => {
    const steps = [...prefix, { id: "s1", action: "navigate", target: { url: "/" } }, { id: "s2", action: "click", target: { role: "button", name: "Add to cart" } }] as any[];
    expect(redirectPostLoginNavigate(steps, prefix.length, auth, "https://www.saucedemo.com")).toBe("s1");
    expect(steps[2].target.url).toBe("/inventory.html");
  });

  it("a navigate to any other page is left alone", () => {
    const steps = [...prefix, { id: "s1", action: "navigate", target: { url: "/cart.html" } }] as any[];
    expect(redirectPostLoginNavigate(steps, prefix.length, auth, "https://www.saucedemo.com")).toBeUndefined();
    expect(steps[2].target.url).toBe("/cart.html");
  });

  it("a site whose login is on its own path: '/' is not the login page, so nothing moves", () => {
    const a = { ...auth, loginUrl: "https://app.example.com/login", url: "https://app.example.com/dashboard" };
    const steps = [{ id: "auth-0", action: "navigate", target: { url: a.loginUrl } }, { id: "s1", action: "navigate", target: { url: "/" } }] as any[];
    expect(redirectPostLoginNavigate(steps, 1, a, "https://app.example.com")).toBeUndefined();
    expect(steps[1].target.url).toBe("/");
  });

  it("a login that stayed on the same URL moves nothing", () => {
    const a = { ...auth, url: auth.loginUrl };
    const steps = [...prefix, { id: "s1", action: "navigate", target: { url: "/" } }] as any[];
    expect(redirectPostLoginNavigate(steps, prefix.length, a, "https://www.saucedemo.com")).toBeUndefined();
  });
});

describe("TD-141 a step naming an element by its exact test id", () => {
  const INVENTORY = {
    url: "https://www.saucedemo.com/inventory.html", title: "Swag Labs", forms: [],
    elements: [
      { role: "button", name: "Add to cart", testId: "add-to-cart-sauce-labs-backpack", id: "add-to-cart-sauce-labs-backpack", css: "[data-test=\"add-to-cart-sauce-labs-backpack\"]", visible: true },
      { role: "button", name: "Add to cart", testId: "add-to-cart-sauce-labs-bike-light", id: "add-to-cart-sauce-labs-bike-light", css: "[data-test=\"add-to-cart-sauce-labs-bike-light\"]", visible: true },
      { role: "button", name: "Cart, empty", testId: "shopping-cart-link", id: "button_7", css: "[data-test=\"shopping-cart-link\"]", visible: true },
    ],
  };
  const ground = (target: Record<string, unknown>) => {
    const ir = { meta, steps: [{ id: "s1", action: "navigate", target: { url: "/inventory.html" } }, { id: "s2", action: "click", target }] } as any;
    return { err: groundingError(ir, { baseUrl: meta.baseUrl, pages: [INVENTORY] } as any), t: ir.steps[1].target };
  };

  it("run 08-34-26: name 'add-to-cart-sauce-labs-bike-light' grounds to that one button", () => {
    const { err, t } = ground({ role: "button", name: "add-to-cart-sauce-labs-bike-light", nth: 0 });
    expect(err).toBeNull();
    expect(t.name).toBe("Add to cart");
    expect(t.css).toBe("[data-test=\"add-to-cart-sauce-labs-bike-light\"]");
    expect(t.nth).toBeUndefined();
  });

  it("a real name still wins and is unchanged", () => {
    const { err, t } = ground({ role: "button", name: "Cart, empty" });
    expect(err).toBeNull();
    expect(t.css).toBe("[data-test=\"shopping-cart-link\"]");
  });

  it("a partial id is not an id: still rejected", () => {
    expect(ground({ role: "button", name: "add-to-cart" }).err).not.toBeNull();
  });

  it("an id under an incompatible role is not taken", () => {
    expect(ground({ role: "textbox", name: "add-to-cart-sauce-labs-backpack" }).err).not.toBeNull();
  });
});

describe("TD-142 routeToControl names the click that leads to a missing control", async () => {
  const { routeToControl } = await import("../src/stages/screenMap.js");
  const { readFileSync } = await import("node:fs");
  const map = JSON.parse(readFileSync(new URL("./fixtures/screenMap/eoi-map.json", import.meta.url), "utf8"));

  it("run 09-07-56: on form screen 2, 'Preferred Project' is one 'Next' away", () => {
    const s = routeToControl(map, "b8b2751745d0", "Preferred Project");
    expect(s).toContain('button "Next"');
    expect(s).toContain("BEFORE this step");
  });

  it("two screens away: both clicks, in order", () => {
    expect(routeToControl(map, "e17c131be715", "preferred unit type")).toContain('button "Next", then button "Next"');
  });

  it("a control on the screen itself, or one no screen has, gives nothing", () => {
    expect(routeToControl(map, "b8b2751745d0", "Self Use")).toBeUndefined();
    expect(routeToControl(map, "b8b2751745d0", "Nonexistent Field")).toBeUndefined();
  });

  it("no route forward (only reachable backwards) gives nothing", () => {
    expect(routeToControl(map, "779aae4b65a1", "Self Use")).toBeUndefined();
  });
});

describe("TD-143 a field named by its words grounds to the one field that has them", () => {
  const CHECKOUT = {
    url: "https://www.saucedemo.com/checkout-step-one.html", title: "Swag Labs", forms: [],
    elements: [
      { role: "textbox", name: "First Name", css: "[data-test=\"firstName\"]", visible: true },
      { role: "textbox", name: "Last Name", css: "[data-test=\"lastName\"]", visible: true },
      { role: "textbox", name: "Zip/Postal Code", css: "[data-test=\"postalCode\"]", visible: true },
    ],
  };
  const ground = (target: Record<string, unknown>, page: any = CHECKOUT) => {
    const ir = { meta, steps: [{ id: "s1", action: "navigate", target: { url: "/checkout-step-one.html" } }, { id: "s2", action: "fill", target, value: "12345" }] } as any;
    return { err: groundingError(ir, { baseUrl: meta.baseUrl, pages: [page] } as any), t: ir.steps[1].target };
  };

  it("run 09-38-53: 'zip code' is 'Zip/Postal Code'", () => {
    const { err, t } = ground({ role: "textbox", name: "zip code" });
    expect(err).toBeNull();
    expect(t.name).toBe("Zip/Postal Code");
    expect(t.css).toBe("[data-test=\"postalCode\"]");
  });

  it("two fields with those words: still rejected", () => {
    const page = { ...CHECKOUT, elements: [...CHECKOUT.elements, { role: "textbox", name: "Zip/Area Code", css: "#bz", visible: true }] };
    expect(ground({ role: "textbox", name: "zip code" }, page).err).not.toBeNull();
  });

  it("a word that is only part of a word does not count", () => {
    expect(ground({ role: "textbox", name: "post code" }).err).not.toBeNull();
  });
});

describe("TD-144 an unlabeled checkbox is named by the text after it", async () => {
  const { extractCrawlResponse } = await import("../src/stages/domExtract.js");
  // the-internet.herokuapp.com/checkboxes, verbatim structure (run 2026-10-16T09-44-36).
  const html = `<html><body><div class="example"><h3>Checkboxes</h3>
    <form id='checkboxes'>
      <input type="checkbox"> checkbox 1</br>
      <input type="checkbox" checked> checkbox 2
    </form></div></body></html>`;

  it("names 'checkbox 1' / 'checkbox 2' (not 'on'), each with its own exact selector", () => {
    const r = extractCrawlResponse(html, "https://the-internet.herokuapp.com/checkboxes", 200);
    const boxes = r.interactive_elements.filter((e) => e.role === "checkbox");
    expect(boxes.map((e) => e.name)).toEqual(["checkbox 1", "checkbox 2"]);
    expect(boxes.map((e) => e.css)).toEqual(["#checkboxes > input:nth-of-type(1)", "#checkboxes > input:nth-of-type(2)"]);
    expect(r.forms[0].fields.map((f) => f.label)).toEqual(["checkbox 1", "checkbox 2"]);
  });

  it("a checkbox with a real value attribute and an id keeps both", () => {
    const r = extractCrawlResponse(`<html><body><form><input type="checkbox" id="nl" value="Newsletter"></form></body></html>`, "https://x.example.com/", 200);
    const box = r.interactive_elements.find((e) => e.role === "checkbox")!;
    expect(box.name).toBe("Newsletter");
    expect(box.css).toBe("#nl");
  });

  it("a text box is unchanged: no following-text name, no positional selector", () => {
    const r = extractCrawlResponse(`<html><body><form><label>City</label><input type="text"> km</form></body></html>`, "https://x.example.com/", 200);
    const box = r.interactive_elements.find((e) => e.role === "textbox")!;
    expect(box.name).toBe("City");
    expect(box.css).toBe("");
  });
});

describe("TD-145 a submitted form's empty fields are named when the next step's element is missing", async () => {
  const { unfilledFormFields } = await import("../src/stages/ir.js");
  const field = (id: string, placeholder: string, inputType = "text") =>
    ({ tag: "input", inputType, name: id, placeholder, label: "", required: false, value: "", options: [], id, ariaLabel: placeholder });
  const model = {
    baseUrl: "https://www.saucedemo.com",
    pages: [{
      url: "https://www.saucedemo.com/checkout-step-one.html", title: "", elements: [],
      forms: [{ action: "", method: "GET", id: "", name: "", ariaLabel: "", fields: [
        field("firstName", "First Name"), field("lastName", "Last Name"), field("postalCode", "Zip/Postal Code"),
        { ...field("continue", "", "submit"), value: "Continue" },
      ] }],
    }, {
      url: "https://www.saucedemo.com/inventory.html", title: "", elements: [],
      forms: [{ action: "", method: "GET", id: "", name: "", ariaLabel: "", fields: [field("search", "Search")] }],
    }],
  } as any;
  const fill = (name: string, css?: string) => ({ id: "f", action: "fill", target: { role: "textbox", name, ...(css ? { css } : {}) }, value: "x" });
  const ir = (steps: any[]) => ({ meta, steps: [...steps, { id: "z", action: "click", target: { role: "button", name: "Finish" } }] }) as any;

  it("run 10-59-00: First Name and Zip filled, Continue clicked -> 'Last Name' is named", () => {
    const steps = [fill("First Name"), fill("Zip/Postal Code", "[data-test=\"postalCode\"]"), { id: "c", action: "click", target: { role: "button", name: "Continue" } }];
    expect(unfilledFormFields(ir(steps), model, 3)).toEqual({ empty: ["Last Name"] });
  });

  it("every field filled: nothing", () => {
    const steps = [fill("First Name"), fill("Last Name"), fill("Zip/Postal Code"), { id: "c", action: "click", target: { role: "button", name: "Continue" } }];
    expect(unfilledFormFields(ir(steps), model, 4)).toEqual({ empty: [] });
  });

  it("run 11-39-31: filled, never submitted -> the empty fields AND its submit button", () => {
    expect(unfilledFormFields(ir([fill("First Name"), fill("Zip/Postal Code")]), model, 2)).toEqual({ empty: ["Last Name"], submit: "Continue" });
  });

  it("every field filled, never submitted -> only the submit button", () => {
    expect(unfilledFormFields(ir([fill("First Name"), fill("Last Name"), fill("Zip/Postal Code")]), model, 3)).toEqual({ empty: [], submit: "Continue" });
  });

  it("a form no step touched (the search box) is never named", () => {
    const steps = [fill("Unrelated"), { id: "c", action: "click", target: { role: "button", name: "Go" } }];
    expect(unfilledFormFields(ir(steps), model, 2)).toEqual({ empty: [] });
  });
});

describe("TD-146 a missing role+name is answered with the closest real elements", async () => {
  const { similarElementsHint } = await import("../src/stages/ir.js");
  const els = [
    { role: "button", name: "Add to cart", testId: "add-to-cart-sauce-labs-backpack", visible: true },
    { role: "button", name: "Add to cart", testId: "add-to-cart-sauce-labs-onesie", visible: true },
    { role: "link", name: "About", visible: true },
    { role: "textbox", name: "Search", visible: true },
    { role: "button", name: "Hidden thing", visible: false },
  ] as any[];

  it("run 12-08-10: 'Add to cart - Sauce Labs Backpack' -> 'Add to cart' first, with its test ids", () => {
    const s = similarElementsHint([{ url: "https://www.saucedemo.com/inventory.html", elements: els }], "button", "add to cart - sauce labs backpack");
    expect(s.indexOf('button "Add to cart" (2 of them; test ids: add-to-cart-sauce-labs-backpack, add-to-cart-sauce-labs-onesie)')).toBeGreaterThan(0);
    expect(s.indexOf('"Add to cart"')).toBeLessThan(s.indexOf('"About"'));
    expect(s).not.toContain("Search");       // a textbox is not a button
    expect(s).not.toContain("Hidden thing"); // not visible
  });

  it("a site with no test ids: twins are told apart by nth", () => {
    const s = similarElementsHint([{ url: "https://x.example.com/", elements: [{ role: "button", name: "Buy", visible: true }, { role: "button", name: "Buy", visible: true }] as any }], "button", "buy now");
    expect(s).toContain('"Buy" (2 of them, in page order: pick one with "nth"');
  });

  it("run 13-33-16: page unknown -> every element names its page, and the model is told not to borrow", () => {
    const s = similarElementsHint([
      { url: "https://www.saucedemo.com/", elements: [{ role: "textbox", name: "Username", visible: true }] as any },
      { url: "https://www.saucedemo.com/cart.html", elements: [{ role: "button", name: "Checkout", visible: true }] as any },
    ], "textbox", "first name");
    expect(s).toContain('textbox "Username" on /');
    expect(s).toContain("rather than borrowing one from another page");
  });

  it("nothing of a compatible role: no hint", () => {
    expect(similarElementsHint([{ url: "https://x.example.com/", elements: [{ role: "heading", name: "Hi", visible: true }] as any }], "button", "go")).toBe("");
  });
});

describe("TD-147 a url_contains after a button click is checked against the live capture (Salesforce screen mode)", async () => {
  const { screenBoundaries } = await import("../src/stages/ir.js");
  const { fingerprintOf } = await import("../src/stages/screens.js");
  const home = {
    url: "https://acme.my.site.com/", title: "Home", forms: [],
    elements: [{ role: "button", name: "Explore Projects", css: "#explore", visible: true }, { role: "button", name: "View Project", css: "#view", visible: true }],
  };
  const model = { baseUrl: "https://acme.my.site.com", pages: [home] } as any;
  const key = fingerprintOf(home as any).key;
  const ir = (value: string) => ({ meta, steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "click", target: { role: "button", name: "Explore Projects" } },
    { id: "s3", action: "assert", value, assertion: "url_contains" },
  ] }) as any;

  it("a url_contains right after a button click is a screen boundary (so it gets captured)", () => {
    expect(screenBoundaries(ir("/project"))).toContain(2);
  });

  it("run 12-14-09: '/project' after a click that stays on '/' is rejected, naming the real URL", () => {
    const err = groundingError(ir("/project"), model, { screenAt: [{ at: 2, key }] });
    expect(err?.index).toBe(2);
    expect(err?.message).toContain('"https://acme.my.site.com/"');
    expect(err?.message).toContain('button "View Project"');
  });

  it("a URL the capture really shows passes", () => {
    expect(groundingError(ir("acme.my.site.com"), model, { screenAt: [{ at: 2, key }] })).toBeNull();
  });

  it("an older capture (not at this step) is never used to judge it", () => {
    expect(groundingError(ir("/project"), model, { screenAt: [{ at: 1, key }] })).toBeNull();
  });

  it("an ordinary run (no screens) is unchanged", () => {
    expect(groundingError(ir("/project"), model)).toBeNull();
  });
});

describe("TD-148 a success check that is only site chrome is rejected", async () => {
  const { chromeSuccessAssertion } = await import("../src/stages/ir.js");
  const home = { url: "https://acme.example.com/", title: "", forms: [], elements: [
    { role: "link", name: "Projects", landmark: "nav", visible: true },
    { role: "link", name: "Careers", landmark: "footer", visible: false },
    { role: "button", name: "Explore Projects", landmark: "main", visible: true },
    { role: "heading", name: "Our projects", landmark: "main", visible: true },
  ] };
  const model = { baseUrl: "https://acme.example.com", pages: [home] } as any;
  const ir = (...tail: any[]) => ({ meta, steps: [{ id: "s1", action: "navigate", target: { url: "/" } }, ...tail] }) as any;
  const click = { id: "s2", action: "click", target: { role: "button", name: "Explore Projects" } };
  const see = (role: string, name: string, id = "s3") => ({ id, action: "assert", target: { role, name }, assertion: "visible" });

  it("run 13-49-29: click, then assert the header's 'Projects' link -> rejected", () => {
    expect(chromeSuccessAssertion(ir(click, see("link", "Projects")), model)?.message).toContain("part of the site's nav");
  });
  it("a check of page content after the click is fine", () => {
    expect(chromeSuccessAssertion(ir(click, see("heading", "Our projects")), model)).toBeNull();
  });
  it("chrome plus one real check is fine", () => {
    expect(chromeSuccessAssertion(ir(click, see("link", "Projects"), see("heading", "Our projects", "s4")), model)).toBeNull();
  });
  it("a smoke check after only opening the page is fine", () => {
    expect(chromeSuccessAssertion(ir(see("link", "Projects", "s2")), model)).toBeNull();
  });
  it("a chrome element that was hidden before (a menu that opens) is fine", () => {
    expect(chromeSuccessAssertion(ir(click, see("link", "Careers")), model)).toBeNull();
  });
});

describe("TD-149 first run, no map: the buttons a screen brought that no step clicked are named", async () => {
  const { fingerprintOf } = await import("../src/stages/screens.js");
  const header = [{ role: "button", name: "Book a Viewing", css: "#bv", visible: true }];
  const project = { url: "https://acme.my.site.com/p", title: "P", forms: [], elements: [
    ...header, { role: "button", name: "Express Interest", css: "#ei", visible: true }] };
  const form1 = { url: "https://acme.my.site.com/p", title: "P", forms: [], elements: [
    ...header, { role: "button", name: "Close", css: "#x", visible: true },
    { role: "textbox", name: "Full Name", css: "#fn", visible: true }, { role: "button", name: "Next", css: "#next", visible: true }] };
  const model = { baseUrl: "https://acme.my.site.com", pages: [project, form1] } as any;
  const kp = fingerprintOf(project as any).key, kf = fingerprintOf(form1 as any).key;
  const ir = { meta, steps: [
    { id: "s1", action: "navigate", target: { url: "/p" } },
    { id: "s2", action: "click", target: { role: "button", name: "Express Interest" } },
    { id: "s3", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "Test User" },
    { id: "s4", action: "select", target: { role: "combobox", name: "Form Purpose" }, value: "Self Use" },
  ] } as any;

  it("run 17-12-23: names 'Close' and 'Next' (new on this screen), not the header's 'Book a Viewing'", () => {
    const err = groundingError(ir, model, { screenAt: [{ at: 1, key: kp }, { at: 2, key: kf }] });
    expect(err?.index).toBe(3);
    const m = err!.message;
    const hint = m.slice(m.indexOf("No step since"), m.indexOf("Controls on the screen"));
    expect(hint).toContain('button "Next"');
    expect(hint).toContain('button "Close"');
    expect(hint).not.toContain("Book a Viewing");
  });

  it("a map route, when there is one, still wins", () => {
    const err = groundingError(ir, model, { screenAt: [{ at: 1, key: kp }, { at: 2, key: kf }], mapRoute: () => "ROUTE-SENTENCE" });
    expect(err?.message).toContain("ROUTE-SENTENCE");
    expect(err?.message).not.toContain("No step since");
  });
});

describe("TD-149 on a wizard, each screen's own 'Next' is still named", async () => {
  const { fingerprintOf } = await import("../src/stages/screens.js");
  const header = [{ role: "button", name: "Book a Viewing", css: "#bv", visible: true }];
  const project = { url: "https://acme.my.site.com/p", title: "P", forms: [], elements: [...header, { role: "button", name: "Express Interest", css: "#ei", visible: true }] };
  const form1 = { url: "https://acme.my.site.com/p", title: "P", forms: [], elements: [...header, { role: "textbox", name: "Full Name", css: "#fn", visible: true }, { role: "button", name: "Next", css: "#n1", visible: true }] };
  const form2 = { url: "https://acme.my.site.com/p", title: "P", forms: [], elements: [...header, { role: "button", name: "Self Use", css: "#su", visible: true }, { role: "button", name: "Back", css: "#b2", visible: true }, { role: "button", name: "Next", css: "#n2", visible: true }] };
  const model = { baseUrl: "https://acme.my.site.com", pages: [project, form1, form2] } as any;
  const k = (p: any) => fingerprintOf(p).key;
  const ir = { meta, steps: [
    { id: "s1", action: "navigate", target: { url: "/p" } },
    { id: "s2", action: "click", target: { role: "button", name: "Express Interest" } },
    { id: "s3", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "T" },
    { id: "s4", action: "click", target: { role: "button", name: "Next" } },
    { id: "s5", action: "click", target: { role: "button", name: "Self Use" } },
    { id: "s6", action: "select", target: { role: "combobox", name: "Preferred Project" }, value: "X" },
  ] } as any;

  it("cold run 17-54-21: screen 2's 'Next' is named although screen 1 had a 'Next' too", () => {
    const m = groundingError(ir, model, { screenAt: [{ at: 1, key: k(project) }, { at: 2, key: k(form1) }, { at: 4, key: k(form2) }] })!.message;
    const hint = m.slice(m.indexOf("No step since"), m.indexOf("Controls on the screen"));
    expect(hint).toContain('button "Next"');
    expect(hint).not.toContain("Self Use");       // clicked since this screen appeared
    expect(hint).not.toContain("Book a Viewing"); // page chrome
  });
});

describe("TD-151 a screen's unfilled fields are named when the flow cannot move on", async () => {
  const { fingerprintOf } = await import("../src/stages/screens.js");
  const form1 = { url: "https://acme.my.site.com/p", title: "P", forms: [], elements: [
    { role: "button", name: "Book a Viewing", css: "#bv", visible: true },
    { role: "textbox", name: "Full Name", css: "#fn", visible: true },
    { role: "textbox", name: "Email Address", css: "#em", visible: true },
    { role: "button", name: "Next", css: "#n", visible: true }] };
  const model = { baseUrl: "https://acme.my.site.com", pages: [form1] } as any;
  const key = fingerprintOf(form1 as any).key;
  const ir = (fill: boolean) => ({ meta, steps: [
    { id: "s1", action: "navigate", target: { url: "/p" } },
    ...(fill ? [{ id: "f", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "T" }] : []),
    { id: "s2", action: "click", target: { role: "button", name: "Next" } },
    { id: "s3", action: "click", target: { role: "button", name: "Self Use" } },
  ] }) as any;

  it("run 18-29-40: Next clicked on an empty form -> the empty fields are named", () => {
    const m = groundingError(ir(false), model, { screenAt: [{ at: 2, key }] })!.message;
    expect(m).toContain('This screen still shows fields no step fills: textbox "Full Name", textbox "Email Address"');
  });

  it("a field a step filled is not named", () => {
    const m = groundingError(ir(true), model, { screenAt: [{ at: 3, key }] })!.message;
    expect(m).toContain('textbox "Email Address"');
    expect(m.slice(m.indexOf("This screen still shows"), m.indexOf("then click its forward button"))).not.toContain("Full Name");
  });
});

describe("TD-152 a click on a heading that has a same-name link is the link", () => {
  const home = { url: "https://shop.example.com/", title: "", forms: [], elements: [
    { role: "link", name: "Samsung galaxy s6", visible: true },
    { role: "heading", name: "Samsung galaxy s6", visible: true },
    { role: "heading", name: "Categories", visible: true },
  ] };
  const model = { baseUrl: "https://shop.example.com", pages: [home] } as any;
  const ground = (name: string) => {
    const ir = { meta, steps: [{ id: "s1", action: "navigate", target: { url: "/" } }, { id: "s2", action: "click", target: { role: "heading", name } }] } as any;
    return { err: groundingError(ir, model), t: ir.steps[1].target };
  };
  it("run 18-46-08: heading 'Samsung galaxy s6' -> the link", () => {
    const { err, t } = ground("Samsung galaxy s6");
    expect(err).toBeNull();
    expect(t.role).toBe("link");
  });
  it("a heading with no same-name link stays a heading", () => {
    expect(ground("Categories").t.role).toBe("heading");
  });
});
