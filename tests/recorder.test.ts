import { describe, expect, it } from "vitest";
import { IR, type Step } from "../src/schema/ir.js";
import { generateSpec } from "../src/stages/generator.js";
import {
  appendAction, defaultRecordingTitle, isAllowedScheme, isBlockedAddress, normaliseStartUrl,
  PASSWORD_REF, recordingIr, stepsAsText, USERNAME_REF, withCredentialRefs, type RecordedAction,
} from "../src/stages/recorder.js";

const run = (actions: RecordedAction[]): Step[] => actions.reduce<Step[]>((s, a) => appendAction(s, a), []);
const email = { role: "textbox", name: "Email" };
const pass = { role: "textbox", name: "Password" };

describe("recorder: actions -> steps", () => {
  it("records a login as the step editor's sentences", () => {
    const steps = run([
      { kind: "navigate", url: "https://shop.test/login" },
      { kind: "click", target: email },
      { kind: "fill", target: email, value: "a@", secret: false },
      { kind: "fill", target: email, value: "a@b.com", secret: false },
      { kind: "click", target: pass },
      { kind: "fill", target: pass, value: "", secret: true },
      { kind: "click", target: { role: "button", name: "Sign In" } },
      { kind: "assert_visible", target: { role: "heading", name: "Welcome back" } },
    ]);
    expect(stepsAsText(steps).map((s) => s.text)).toEqual([
      "Go to https://shop.test/login",
      'Type "a@b.com" into textbox "Email"',
      `Type "${PASSWORD_REF}" into textbox "Password"`,
      'Click on button "Sign In"',
      'Check that heading "Welcome back" appears on the page',
    ]);
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
  });

  it("never stores a typed password: the secret flag wins over any value", () => {
    const steps = run([{ kind: "fill", target: pass, value: "hunter2", secret: true }]);
    expect(JSON.stringify(steps)).not.toContain("hunter2");
  });

  it("keeps clicks on a box that is NOT then typed into", () => {
    const steps = run([{ kind: "click", target: email }, { kind: "click", target: pass }]);
    expect(steps.map((s) => s.action)).toEqual(["click", "click"]);
  });

  it("does not repeat a navigate to the address it is already on", () => {
    const steps = run([{ kind: "navigate", url: "https://a.test/" }, { kind: "navigate", url: "https://a.test/" }]);
    expect(steps).toHaveLength(1);
  });

  it("merges repeated choices in one dropdown, and records press / text / url checks", () => {
    const country = { role: "combobox", name: "Country" };
    const steps = run([
      { kind: "select", target: country, value: "India" },
      { kind: "select", target: country, value: "United States" },
      { kind: "press", key: "Enter" },
      { kind: "assert_text", text: "Order placed" },
      { kind: "assert_url", value: "/orders" },
    ]);
    expect(stepsAsText(steps).map((s) => s.text)).toEqual([
      'Choose "United States" from combobox "Country"',
      "Press the Enter key",
      'Check that the text "Order placed" is displayed',
      'Check the page address contains "/orders"',
    ]);
  });

  it("turns the box typed into just before a password into the username reference", () => {
    const steps = withCredentialRefs(run([
      { kind: "fill", target: email, value: "me@corp.com", secret: false },
      { kind: "click", target: pass },
      { kind: "fill", target: pass, value: "", secret: true },
    ]));
    expect(steps.map((s) => s.value)).toEqual([USERNAME_REF, PASSWORD_REF]);
  });

  it("leaves other typed values alone", () => {
    const steps = withCredentialRefs(run([{ kind: "fill", target: { role: "searchbox", name: "Search" }, value: "shoes", secret: false }]));
    expect(steps[0].value).toBe("shoes");
  });

  it("names a recording after its first page", () => {
    expect(defaultRecordingTitle(run([{ kind: "navigate", url: "https://learn.example.com/x" }]))).toBe("Recorded flow on learn.example.com");
    expect(defaultRecordingTitle([])).toBe("Recorded flow");
  });
});

describe("recorder: the script it previews", () => {
  it("builds a valid IR and a Playwright spec with the login only as env references", () => {
    const steps = run([
      { kind: "navigate", url: "https://shop.test/login" },
      { kind: "fill", target: email, value: "me@corp.com", secret: false },
      { kind: "fill", target: pass, value: "hunter2", secret: true },
      { kind: "click", target: { role: "button", name: "Sign In" } },
    ]);
    const ir = IR.parse(recordingIr(steps, "https://shop.test/login", "Login works"));
    expect(ir.meta.baseUrl).toBe("https://shop.test");
    expect(ir.meta.title).toBe("Login works");
    const spec = generateSpec(ir, "artifacts");
    expect(spec).toContain("process.env");
    expect(spec).toContain("Sign In");
    expect(spec).not.toContain("me@corp.com");
    expect(spec).not.toContain("hunter2");
  });
});

describe("recorder: network guard", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "[::1]",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"])("allows %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it("allows only web schemes", () => {
    expect(isAllowedScheme("https://a.test/")).toBe(true);
    expect(isAllowedScheme("data:text/html,hi")).toBe(true);
    expect(isAllowedScheme("file:///etc/passwd")).toBe(false);
    expect(isAllowedScheme("chrome://settings")).toBe(false);
  });

  it("normalises a typed start address", () => {
    expect(normaliseStartUrl("example.com/login")).toBe("https://example.com/login");
    expect(normaliseStartUrl("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(normaliseStartUrl("file:///etc/passwd")).toBeNull();
    expect(normaliseStartUrl("")).toBeNull();
    expect(normaliseStartUrl(42)).toBeNull();
  });
});
