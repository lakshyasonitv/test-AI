import { describe, it, expect } from "vitest";
import { lastFillIndexByKind, applyCredentials, type CredentialKind } from "../src/stages/credentials.js";

describe("auth boundary scoping", () => {
  const creds = { username: "vaibhav.parmar@thinkvibes.com", password: "secretpassword", secret: true };

  // In a real run, fieldMap is built by credentialFieldMap(appModel) from DOM inputType (email/password),
  // which maps placeholders like 'you@thinkvibes.com' and '*********' to username and password kinds.
  const fieldMap = new Map<string, CredentialKind>([
    ["you@thinkvibes.com", "username"],
    ["*********", "password"],
    ["email", "username"],
  ]);

  it("restricts lastFillIndexByKind to the login form fields when post-login forms exist", () => {
    const steps = [
      { action: "navigate", target: { url: "/login" } },
      { action: "fill", target: { role: "textbox", name: "you@thinkvibes.com" }, value: "admin@example.com" }, // index 1 (username)
      { action: "fill", target: { role: "textbox", name: "*********" }, value: "password123" },              // index 2 (password)
      { action: "click", target: { role: "button", name: "Sign In" } },                                     // index 3
      { action: "click", target: { role: "button", name: "Add New" } },
      { action: "fill", target: { role: "textbox", name: "Email" }, value: "newuser@example.com" },         // index 5 (post-login email)
    ];

    const lastOfKind = lastFillIndexByKind(steps, fieldMap);
    expect(lastOfKind.get("username")).toBe(1);
    expect(lastOfKind.get("password")).toBe(2);
  });

  it("substitutes credentials into login fields while preserving post-login form values", () => {
    const steps = [
      { action: "navigate", target: { url: "/login" } },
      { action: "fill", target: { role: "textbox", name: "you@thinkvibes.com" }, value: "admin@example.com" },
      { action: "fill", target: { role: "textbox", name: "*********" }, value: "password123" },
      { action: "click", target: { role: "button", name: "Sign In" } },
      { action: "wait", value: "2000" },
      { action: "click", target: { role: "button", name: "Admin" } },
      { action: "click", target: { role: "button", name: "Users" } },
      { action: "click", target: { role: "button", name: "Add New" } },
      { action: "fill", target: { role: "textbox", name: "Full Name" }, value: "Test User" },
      { action: "fill", target: { role: "textbox", name: "Email" }, value: "test@thinkvibes.com" },
    ];

    applyCredentials(steps, creds, "full", undefined, fieldMap);

    // Login email: substituted with env reference
    expect(steps[1].value).toBe("${env:TEST_USERNAME}");
    // Login password: substituted with env reference
    expect(steps[2].value).toBe("${env:TEST_PASSWORD}");
    // Add User Full Name: preserved
    expect(steps[8].value).toBe("Test User");
    // Add User Email: preserved untouched!
    expect(steps[9].value).toBe("test@thinkvibes.com");
  });

  it("handles a login-only flow cleanly where no post-login forms exist", () => {
    const steps = [
      { action: "navigate", target: { url: "/login" } },
      { action: "fill", target: { role: "textbox", name: "you@thinkvibes.com" }, value: "user" },
      { action: "fill", target: { role: "textbox", name: "*********" }, value: "pass" },
      { action: "click", target: { role: "button", name: "Submit" } },
    ];

    applyCredentials(steps, creds, "full", undefined, fieldMap);

    expect(steps[1].value).toBe("${env:TEST_USERNAME}");
    expect(steps[2].value).toBe("${env:TEST_PASSWORD}");
  });
});
