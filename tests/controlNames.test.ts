import { describe, it, expect, vi } from "vitest";

// The request's own control names, put back into the generated cases exactly (TD-127).
//
// Run 2026-10-15T03-01-14: the case generator turned "select for eoi" into "click the control
// labelled 'Select' for EOI", and the IR stage then looked for a button named "Select". The prompt
// already asked for verbatim names; this is the code check behind it, Salesforce runs only.

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { extractControlNames, restoreNamesInText, restoreControlNames } = await import("../src/stages/controlNames.js");
const { toTestCases } = await import("../src/stages/testCases.js");
const { withTargetApp } = await import("../src/runTarget.js");

// The user's real request from that run, with "Select for EOI" and "Self Use" written as names.
const REQUEST =
  "click on Explore Projects then click on View Project then click on Select for EOI then click on Express Interest " +
  "then fill form with In the Full Name textbox, enter test full name In the Email Address textbox, enter test@gmail.com," +
  "In the Phone Number combobox, select +971 (UAE) In the Phone Number textbox, enter 1234567890 Click the Next button," +
  "click Self Use,In the Min Budget (AED) combobox, select 40,In the Max Budget (AED) combobox, select 50," +
  "In the Buying Timeline combobox, select later,Click the Next button,In the Property Type combobox, select The Sanctuary," +
  "In the Preferred Areas combobox, select Abu Dhabi , in Preferred Unit Type select office and submit form.";

describe("extractControlNames", () => {
  const names = extractControlNames(REQUEST);

  it("finds the multi-word and control-noun names, exactly as written", () => {
    for (const n of ["Explore Projects", "View Project", "Select for EOI", "Express Interest", "Full Name",
      "Email Address", "Phone Number", "Next", "Self Use", "Min Budget (AED)", "Max Budget (AED)", "Buying Timeline",
      "Property Type", "Preferred Areas", "Preferred Unit Type"]) {
      if (n === "Select for EOI") continue; // "for" is lower-case: see the next test
      expect(names, n).toContain(n);
    }
  });

  it("never takes a lone sentence-starting word, and a lower-case name is out of reach", () => {
    for (const n of ["In", "Click", "In the"]) expect(names).not.toContain(n);
    // "Select for EOI" has a lower-case word in it, so as unquoted prose it is not one phrase.
    expect(names).not.toContain("Select for EOI");
    // Quoted, it is.
    expect(extractControlNames(`then click 'Select for EOI'`)).toContain("Select for EOI");
  });

  it("returns longest first, so a longer name is restored before a name inside it", () => {
    const n = extractControlNames(`the Phone Number combobox and the Number button`);
    expect(n.indexOf("Phone Number")).toBeLessThan(n.indexOf("Number"));
  });
});

describe("restoreNamesInText", () => {
  it("re-joins a name cut short inside quotes", () => {
    expect(restoreNamesInText("click the control labelled 'Select' for EOI to begin", ["Select for EOI"]))
      .toBe("click the control labelled 'Select for EOI' to begin");
  });

  it("restores the person's letter case for a multi-word name before a control noun", () => {
    expect(restoreNamesInText("In the min budget (AED) combobox, select the '40' option.", ["Min Budget (AED)"]))
      .toBe("In the Min Budget (AED) combobox, select the '40' option.");
  });

  it("restores a name only in quotes or before a control noun — never in prose", () => {
    expect(restoreNamesInText("Type the phone number into the 'phone number' textbox.", ["Phone Number"]))
      .toBe("Type the phone number into the 'Phone Number' textbox.");
    expect(restoreNamesInText("In the purpose combobox, choose self.", ["Purpose"])).toBe("In the Purpose combobox, choose self.");
    expect(restoreNamesInText("Click the 'next' button.", ["Next"])).toBe("Click the 'Next' button.");
    expect(restoreNamesInText("Click 'Next' to go to the next step.", ["Next"])).toBe("Click 'Next' to go to the next step.");
  });

  it("leaves text alone when nothing applies, and is idempotent", () => {
    const t = "Type the phone number into the 'Phone Number' textbox.";
    expect(restoreNamesInText(t, ["Phone Number"])).toBe(t);
    const once = restoreNamesInText("labelled 'Select' for EOI", ["Select for EOI"]);
    expect(restoreNamesInText(once, ["Select for EOI"])).toBe(once);
  });
});

describe("toTestCases restores the request's names on a Salesforce run only", () => {
  const HOST = "https://sf.example";
  const appModel: any = { baseUrl: HOST, pages: [{ url: `${HOST}/`, title: "Home", concepts: ["EOI"], elements: [{ role: "button", name: "Explore Projects" }] }] };
  const PLAN = { goal: "g", steps: ["a"], testTypeScope: ["functionality"], coverage: "standard" } as any;
  // The paraphrases the real run's case generator produced.
  const generated = [{
    title: "Express interest", priority: "high", feature: "EOI", category: "valid", fromPrompt: true, intent: "i", whyItMatters: "w",
    steps: [
      "On the project detail, click the control labelled 'Select' for EOI to begin expressing interest.",
      "In the min budget (AED) combobox, select the '40' option as the minimum budget.",
      "Click the 'Next' button to continue to the next step of the interest form.",
    ],
    expected: "The express interest form is submitted",
  }];
  const reply = { content: JSON.stringify(generated), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  const req = (tag: string) => `${tag} then click 'Select for EOI', In the Min Budget (AED) combobox select 40, Click the Next button`;

  it("Salesforce run: names restored exactly", async () => {
    geminiMock.mockReset(); geminiMock.mockResolvedValue(reply);
    const cases = await withTargetApp("salesforce", () =>
      toTestCases(PLAN, appModel, undefined, { sourcePrompt: req(`sf ${Date.now()}`) }));
    expect(cases[0].steps).toEqual([
      "On the project detail, click the control labelled 'Select for EOI' to begin expressing interest.",
      "In the Min Budget (AED) combobox, select the '40' option as the minimum budget.",
      "Click the 'Next' button to continue to the next step of the interest form.",
    ]);
  });

  it("ordinary run: the model's cases are returned untouched", async () => {
    geminiMock.mockReset(); geminiMock.mockResolvedValue(reply);
    const cases = await toTestCases(PLAN, appModel, undefined, { sourcePrompt: req(`plain ${Date.now()}`) });
    expect(cases[0].steps).toEqual(generated[0].steps);
  });

  it("restoreControlNames counts what it changed", () => {
    const { changed } = restoreControlNames(generated as any, req("x"));
    expect(changed).toBe(2);
  });
});
