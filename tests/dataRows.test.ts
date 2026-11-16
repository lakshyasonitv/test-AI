import { describe, it, expect } from "vitest";
import { dataRowsOf, rowCases } from "../src/stages/dataRows.js";
import type { TestCase } from "../src/stages/testCases.js";

const REQUEST = `Create an Account named {Name} with Industry {Industry} and Annual Revenue {Revenue}, then verify the industry
Data:
Name,Industry,Revenue
O'Connor & Sons,Banking,75000
"Zeta-9 Labs, Inc",Not For Profit,0
Acme,Energy,"1,250,000.5"`;

describe("data-driven runs (dataRows.ts)", () => {
  it("a three-row table gives three filled requests", () => {
    const d = dataRowsOf(REQUEST)!;
    expect(d.prompts).toEqual([
      "Create an Account named O'Connor & Sons with Industry Banking and Annual Revenue 75000, then verify the industry",
      "Create an Account named Zeta-9 Labs, Inc with Industry Not For Profit and Annual Revenue 0, then verify the industry",
      "Create an Account named Acme with Industry Energy and Annual Revenue 1,250,000.5, then verify the industry",
    ]);
    expect(d.rows[1].Name).toBe("Zeta-9 Labs, Inc");
  });

  it("an ordinary request, or a Data block the request never uses, is not data-driven", () => {
    expect(dataRowsOf("Create an Account named Acme")).toBeNull();
    expect(dataRowsOf("Create an Account named Acme\nData:\nName\nBeta")).toBeNull();
    expect(dataRowsOf("Create an Account named {Name}\nData:\nName")).toBeNull();
  });

  it("each further row gets its own case with its own values and its own request", () => {
    const d = dataRowsOf(REQUEST)!;
    const primary = {
      title: "Create Account O'Connor & Sons", steps: ["Fill Account Name with O'Connor & Sons", "Select Industry Banking", "Fill Annual Revenue with 75000"],
      expected: "The account shows Industry Banking", fromPrompt: true,
    } as unknown as TestCase;
    const [r2, r3] = rowCases(primary, d);
    expect(r2.title).toBe("Create Account Zeta-9 Labs, Inc (row 2)");
    expect(r2.steps).toEqual(["Fill Account Name with Zeta-9 Labs, Inc", "Select Industry Not For Profit", "Fill Annual Revenue with 0"]);
    expect(r2.expected).toBe("The account shows Industry Not For Profit");
    expect(r2.rowPrompt).toBe(d.prompts[1]);
    expect(r3.steps[2]).toBe("Fill Annual Revenue with 1,250,000.5");
    expect(primary.steps[0]).toBe("Fill Account Name with O'Connor & Sons"); // row 1 untouched
  });

  it("a value equal to another row's value is swapped once, not chained", () => {
    const d = dataRowsOf("Make {A} then {B}\nData:\nA,B\nx,y\ny,z")!;
    const [r2] = rowCases({ title: "x y", steps: ["x", "y"], expected: "x y" } as unknown as TestCase, d);
    expect(r2.steps).toEqual(["y", "z"]);
  });
});
