import { describe, it, expect } from "vitest";
import { groundingError, buildLoginPrefix } from "../src/stages/ir.js";

/**
 * The field-hint guard (D-48): a fill/select/check the generator will emit as
 * `field(page, hint, …)` must name something that IS a label, placeholder or accessible name of a
 * field on the recorded page — proved from AppModel STRUCTURE, never from page or prompt wording
 * (CLAUDE.md's central rule, TD-01).
 *
 * The first block is the real failure: Salesforce's login page carries
 * `<input type="hidden" name="passwordShown" value="false">` (fetched for D-45), grounding's
 * substring tier matched `{role:"textbox", name:"Password"}` to it, renamed the step, and the
 * generator emitted `field(page, "passwordShown", "fill")`, which sat out its timeout at run time.
 */

const URL_ = "https://acme.my.salesforce.com/";
const meta = { feature: "f", title: "t", priority: "high", sourcePrompt: "", baseUrl: "https://acme.my.salesforce.com" };

/** Salesforce's first login screen, as discovery records it. */
const SF_LOGIN = {
  url: URL_, title: "Login",
  forms: [{
    action: "", method: "post", id: "login_form", name: "", ariaLabel: "",
    fields: [
      { tag: "input", inputType: "hidden", name: "passwordShown", placeholder: "", label: "", required: false, value: "false", options: [], id: "", ariaLabel: "" },
      { tag: "input", inputType: "email", name: "username", placeholder: "", label: "Username", required: false, value: "", options: [], id: "username", ariaLabel: "" },
    ],
  }],
  elements: [
    // The hidden input, as an element with no css — exactly what the substring tier reached.
    { role: "textbox", name: "passwordShown", visible: true },
    { role: "textbox", name: "Username", css: "#username", visible: true },
    { role: "checkbox", name: "Remember me", css: "#rememberUn", visible: true },
    { role: "button", name: "Log In to Sandbox", css: "#Login", visible: true },
  ],
};

/** An ordinary formless SPA page — the shape a regression would hit first. */
const SPA = {
  url: "https://shop.example.com/", title: "Shop", forms: [],
  elements: [
    { role: "textbox", name: "Search products", visible: true },              // placeholder-named
    { role: "textbox", name: "Full Name", nameFromProximity: true, visible: true }, // <div>Full Name</div><input>
    { role: "combobox", name: "Country", visible: true },
    { role: "checkbox", name: "Subscribe", visible: true },
    { role: "button", name: "Save", css: "#save", visible: true },
  ],
};

const fillStep = (target: Record<string, unknown>, action = "fill") =>
  ({ id: "s1", action, target, value: action === "check" ? undefined : "x" });
const check = (page: any, target: Record<string, unknown>, action = "fill") => {
  const ir = { meta, steps: [{ id: "s0", action: "navigate", target: { url: page.url } }, fillStep(target, action)] } as any;
  return { err: groundingError(ir, { baseUrl: page.url, pages: [page] } as any), ir };
};

describe("rejects a hint that is not a field's label, placeholder or accessible name", () => {
  it("the real failure: role+name 'Password' grounded by substring to the hidden passwordShown input", () => {
    const { err } = check(SF_LOGIN, { role: "textbox", name: "Password" });
    expect(err?.index).toBe(1);
    expect(err?.message).toContain('"passwordShown"');
    expect(err?.message).toContain("hidden input");
    // …and says what WAS there, so the retry can converge.
    expect(err?.message).toContain('"Username"');
  });

  it("the same hint arriving name-only — the path that skipped every name check", () => {
    const { err } = check(SF_LOGIN, { name: "passwordShown" });
    expect(err?.message).toContain("hidden input");
  });

  it("a hint nothing on the page is called, listing what is", () => {
    const { err } = check(SPA, { label: "Email address" });
    expect(err?.message).toContain('"Email address"');
    expect(err?.message).toContain("no field there is called that");
    expect(err?.message).toContain('"Search products"');
  });

  it("an HTML name attribute, which field() never matches", () => {
    const page = {
      url: "https://app.example.com/", title: "Form", elements: [{ role: "textbox", name: "email_addr", visible: true }],
      forms: [{ action: "", method: "post", id: "", name: "", ariaLabel: "", fields: [
        { tag: "input", inputType: "email", name: "email_addr", placeholder: "", label: "Email", required: false, value: "", options: [], id: "", ariaLabel: "" },
      ] }],
    };
    expect(check(page, { name: "email_addr" }).err?.message).toContain("HTML name attribute");
    // The field's real label is the one that works.
    expect(check(page, { label: "Email" }).err).toBeNull();
  });
});

describe("accepts every hint field() can genuinely resolve — no regression for ordinary pages", () => {
  it("a form field's label", () => {
    expect(check(SF_LOGIN, { label: "Username" }).err).toBeNull();
  });

  it("is case- and whitespace-insensitive", () => {
    expect(check(SF_LOGIN, { label: "  username " }).err).toBeNull();
  });

  it("a formless field named by its placeholder", () => {
    expect(check(SPA, { placeholder: "Search products" }).err).toBeNull();
  });

  it("a field named by the visible text next to it (field()'s DOM-order rung resolves these)", () => {
    expect(check(SPA, { label: "Full Name" }).err).toBeNull();
  });

  it("select and check steps by their names", () => {
    expect(check(SPA, { label: "Country" }, "select").err).toBeNull();
    expect(check(SPA, { label: "Subscribe" }, "check").err).toBeNull();
  });

  it("a role+name fill that grounds to an exact field name", () => {
    expect(check(SPA, { role: "textbox", name: "Search products" }).err).toBeNull();
  });
});

describe("never applies where the generator does not emit field()", () => {
  it("a step with a verified css is emitted by selector, not field()", () => {
    expect(check(SF_LOGIN, { css: "#username", label: "nonsense" }).err).toBeNull();
  });

  it("role+name grounding that attaches a css skips the guard", () => {
    const { err, ir } = check(SF_LOGIN, { role: "textbox", name: "Username" });
    expect(err).toBeNull();
    expect(ir.steps[1].target.css).toBe("#username");
  });

  it("click steps are untouched", () => {
    const ir = { meta, steps: [{ id: "s0", action: "navigate", target: { url: URL_ } }, { id: "s1", action: "click", target: { role: "button", name: "Log In to Sandbox" } }] } as any;
    expect(groundingError(ir, { baseUrl: URL_, pages: [SF_LOGIN] } as any)).toBeNull();
  });

  it("a two-screen login prefix grounds — its steps all carry discovery's own selectors", () => {
    const auth = { status: "authenticated", loginUrl: URL_, url: "https://acme.lightning.force.com/one", loginSteps: [
      { action: "fill", css: "#username", credential: "username" },
      { action: "click", css: "#Login" },
      { action: "waitFor", css: "#password" },
      { action: "fill", css: "#password", credential: "password" },
      { action: "click", css: "#Login" },
    ] } as any;
    const ir = { meta, steps: buildLoginPrefix(auth) } as any;
    expect(groundingError(ir, { baseUrl: URL_, pages: [SF_LOGIN], auth } as any)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Item 7: Target.frame is grounded like css — copied from the element discovery verified, never
// from the model, and only when the element has one (so top-level targets stay key-for-key the
// same; tests/frameTarget.test.ts holds the schema to that).

describe("grounding copies Target.frame from the matched element, like css", () => {
  const FRAMED = {
    url: "https://acme.lightning.force.com/report", title: "Report", forms: [],
    elements: [
      { role: "textbox", name: "Amount", css: "#amt", frame: "iframe#vfFrame", visible: true },
      { role: "button", name: "Run Report", css: "#run", frame: "iframe#vfFrame >>> iframe.inner", visible: true },
      { role: "textbox", name: "Search", css: "#q", visible: true },
    ],
  };
  const ground = (step: Record<string, unknown>) => {
    const ir = { meta, steps: [{ id: "s0", action: "navigate", target: { url: FRAMED.url } }, { id: "s1", ...step }] } as any;
    const err = groundingError(ir, { baseUrl: FRAMED.url, pages: [FRAMED] } as any);
    return { err, target: ir.steps[1].target };
  };

  it("role+name: the frame comes with the css", () => {
    const { err, target } = ground({ action: "fill", target: { role: "textbox", name: "Amount" }, value: "5" });
    expect(err).toBeNull();
    expect(target).toMatchObject({ css: "#amt", frame: "iframe#vfFrame" });
  });

  it("a text-only action target upgraded to the element carries its frame (nested path kept intact)", () => {
    const { err, target } = ground({ action: "click", target: { text: "Run Report" } });
    expect(err).toBeNull();
    expect(target.frame).toBe("iframe#vfFrame >>> iframe.inner");
  });

  it("an already-verified selector gets the frame it lives in", () => {
    const { err, target } = ground({ action: "fill", target: { css: "#amt" }, value: "5" });
    expect(err).toBeNull();
    expect(target.frame).toBe("iframe#vfFrame");
  });

  it("an element in the top-level document adds NO frame key at all", () => {
    const { err, target } = ground({ action: "fill", target: { role: "textbox", name: "Search" }, value: "x" });
    expect(err).toBeNull();
    expect(Object.keys(target)).not.toContain("frame");
  });
});
