import { describe, it, expect } from "vitest";
import { matchOptionIndexFn } from "../src/stages/targetResolver.js";

describe("picking an option by the value (runs 2026-11-13T19-05-44-514Z-52f348c0, 19-05-25-624Z-90c95d42)", () => {
  it("takes an exact option, else the closest one holding the value, else the longest the value holds", () => {
    expect(matchOptionIndexFn(["Zq Work Order Line Items", "Zq Work Orders"], "Zq Work Order")).toBe(1);
    expect(matchOptionIndexFn(["(Zq+14) Zq Islands (Zq/Far)", "(Zq+00) Zq Mean (ZqT)"], "ZqT")).toBe(1);
    expect(matchOptionIndexFn(["Zq Hot", "zq hot"], "ZQ HOT")).toBe(0);
    expect(matchOptionIndexFn(["Zq", "Zq Hot"], "Zq Hot Lead")).toBe(1);
    expect(matchOptionIndexFn(["Zq A"], "Zq B")).toBe(-1);
  });
});
