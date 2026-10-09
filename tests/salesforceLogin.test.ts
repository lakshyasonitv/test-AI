import { describe, it, expect } from "vitest";
import {
  checkSalesforceLogin,
  type LoginFailureReason,
  type SalesforceLoginResult,
} from "../src/server/salesforceLogin.js";

/**
 * Pins the STUB's answer, and through it the shape of the contract in src/server/salesforceLogin.ts.
 *
 * When the real login lands, the first test below is expected to be replaced — it asserts
 * "not implemented" on purpose. The other two describe the contract itself and should survive.
 */

const OPTS = {
  loginUrl: "https://example.my.salesforce.com",
  username: "qa@example.com",
  password: "pw-must-never-echo-7f3a",
};

describe("checkSalesforceLogin (stub)", () => {
  it("answers not-implemented, without throwing", async () => {
    const result: SalesforceLoginResult = await checkSalesforceLogin(OPTS);
    expect(result).toEqual({ ok: false, reason: "unknown", detail: "not implemented" });
  });

  it("accepts the optional totpSecret and answers the same", async () => {
    const result = await checkSalesforceLogin({ ...OPTS, totpSecret: "JBSWY3DPEHPK3PXP" });
    expect(result).toEqual({ ok: false, reason: "unknown", detail: "not implemented" });
  });

  it("never echoes the password or the TOTP secret anywhere in the result", async () => {
    const result = await checkSalesforceLogin({ ...OPTS, totpSecret: "JBSWY3DPEHPK3PXP" });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(OPTS.password);
    expect(serialised).not.toContain("JBSWY3DPEHPK3PXP");
  });
});

describe("the contract's types", () => {
  it("every LoginFailureReason is a valid `reason`", () => {
    // Listed in full so adding or removing a member breaks this test as well as the other stream's
    // build — the file's header comment says a change here must be announced first.
    const reasons: LoginFailureReason[] = [
      "bad-credentials", "verification-required", "mfa-required", "not-found", "timeout", "unknown",
    ];
    const results: SalesforceLoginResult[] = reasons.map((reason) => ({ ok: false, reason }));
    expect(results.map((r) => r.reason)).toEqual(reasons);
  });
});
