import { describe, it, expect } from "vitest";
import { applyCredentials, type Credentials } from "../src/stages/credentials.js";

// TD-156. Seven SauceDemo runs kept a negative case ("locked_out_user" + the REAL password, which
// the login page prints) whose password fill stayed literal in 04-ir.json and the generated spec,
// because applyCredentials leaves a negative case's own values alone. A fill whose value IS the
// real credential now becomes the env reference under every policy: the same value is typed at
// run time, and the literal never reaches disk.

const CREDS: Credentials = { username: "standard_user_x", password: "real_pass_42", secret: true };
const fill = (name: string, value: string) => ({
  action: "fill", target: { role: "textbox", name }, value,
});

describe("TD-156: a fill typing the real credential never stays literal", () => {
  it("negative case (policy none): the real password becomes the env reference, its own username stays", () => {
    const steps = [fill("Username", "locked_out_user"), fill("Password", "real_pass_42")];
    applyCredentials(steps, CREDS, "none");
    expect(steps[0].value).toBe("locked_out_user");
    expect(steps[1].value).toBe("${env:TEST_PASSWORD}");
  });

  it("identifier-only: a deliberately WRONG password is still left as the case wrote it", () => {
    const steps = [fill("Username", "someone"), fill("Password", "wrong-on-purpose")];
    applyCredentials(steps, CREDS, "identifier-only");
    expect(steps[1].value).toBe("wrong-on-purpose");
    expect(steps[0].value).toBe("${env:TEST_USERNAME}");
  });

  it("the real username typed into any field under policy none becomes its reference", () => {
    const steps = [fill("Search", "standard_user_x")];
    applyCredentials(steps, CREDS, "none");
    expect(steps[0].value).toBe("${env:TEST_USERNAME}");
  });

  it("non-secret (built-in) credentials are untouched under policy none, exactly as before", () => {
    const demo: Credentials = { username: "demo", password: "demo-pass" };
    const steps = [fill("Password", "demo-pass")];
    applyCredentials(steps, demo, "none");
    expect(steps[0].value).toBe("demo-pass");
  });
});
