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
