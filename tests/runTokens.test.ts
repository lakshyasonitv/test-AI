import { describe, it, expect } from "vitest";
import { resolveRunTokens, hasRunToken, dateToken, PHONE_TOKEN, UNIQUE_TOKEN, newRunTokenContext } from "../src/text.js";

/**
 * Run tokens are resolved where a value is TYPED, never when the IR is compiled: a saved suite that
 * typed the same phone on every replay tripped duplicate matching, and a date written at compile
 * time goes stale (code review, Session 102).
 */
describe("run tokens", () => {
  const ctx = { uid: "ab12cd", phone: "4155550123", now: Date.UTC(2026, 9, 25, 12) };

  it("recognises the three token kinds and nothing else", () => {
    expect(hasRunToken(`Zq ${UNIQUE_TOKEN}`)).toBe(true);
    expect(hasRunToken(PHONE_TOKEN)).toBe(true);
    expect(hasRunToken(dateToken(30, "en-US"))).toBe(true);
    expect(hasRunToken("{{nope}}")).toBe(false);
    expect(hasRunToken(undefined)).toBe(false);
  });

  it("resolves uid and phone from the context", () => {
    expect(resolveRunTokens(`Mehta ${UNIQUE_TOKEN}`, ctx)).toBe("Mehta ab12cd");
    expect(resolveRunTokens(`asha+${UNIQUE_TOKEN}@example.com`, ctx)).toBe("asha+ab12cd@example.com");
    expect(resolveRunTokens(PHONE_TOKEN, ctx)).toBe("4155550123");
  });

  it("writes a date the way the org user's locale writes it", () => {
    expect(resolveRunTokens(dateToken(30, "en-US"), ctx)).toBe("11/24/2026");
    expect(resolveRunTokens(dateToken(30, "en_GB"), ctx)).toBe("24/11/2026");
    expect(resolveRunTokens(dateToken(30, "de-DE"), ctx)).toBe("24.11.2026");
    expect(resolveRunTokens(dateToken(-1, "en-US"), ctx)).toBe("10/24/2026");
  });

  it("a fresh context has a 10-digit phone and a 6-character code", () => {
    const c = newRunTokenContext();
    expect(c.phone).toMatch(/^[0-9]{10}$/);
    expect(c.uid).toMatch(/^[a-z0-9]{6}$/);
  });
});
