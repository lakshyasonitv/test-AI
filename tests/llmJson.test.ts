import { describe, it, expect } from "vitest";
import { unwrapArray } from "../src/llm/json.js";

/**
 * Tolerant top-level array recovery — the mechanical half of the "model wrapped the JSON array in
 * an envelope" failure.
 *
 * When a stage asks a model (json mode) for a top-level JSON array, most providers return exactly
 * that array. Some models ignore the instruction and wrap it: `{"testCases":[...]}`, `{"cases":
 * [...]}`, or an object whose only key happens to hold the array. A strict `Array.isArray` miss
 * used to turn any of those into `[]` — indistinguishable, at the call site, from "the model
 * really did return nothing" (the class of bug in DECISIONS.D-02/D-03: a deterministic check
 * written against the model's *shape* is only as good as the shapes it admits). `unwrapArray`
 * admits these shapes and leaves the "nothing usable" decision to the caller.
 *
 * Under Gemini a bare array must parse identically to an unwrapped one — that holds here because
 * the first branch returns the array itself, and `tests/testCases.test.ts` exercises the whole
 * bare-array-under-gemini path end to end.
 */

const KEYS = ["cases", "testCases", "test_cases"];

describe("unwrapArray — passes a bare array through untouched", () => {
  it("returns the same reference, so gemini's bare-array answer parses identically", () => {
    const arr = [{ id: 1 }];
    expect(unwrapArray(arr, KEYS)).toBe(arr);
  });

  it("accepts an empty bare array (the caller decides what empty means)", () => {
    expect(unwrapArray([], KEYS)).toEqual([]);
  });
});

describe("unwrapArray — preferred-key envelopes", () => {
  it("unwraps testCases, cases and test_cases by preferred-key order", () => {
    expect(unwrapArray({ testCases: [{ a: 1 }] }, KEYS)).toEqual([{ a: 1 }]);
    expect(unwrapArray({ cases: [{ b: 2 }] }, KEYS)).toEqual([{ b: 2 }]);
    expect(unwrapArray({ test_cases: [{ c: 3 }] }, KEYS)).toEqual([{ c: 3 }]);
  });

  it("picks the FIRST preferred key that holds an array, skipping earlier non-array ones", () => {
    expect(unwrapArray({ cases: "not an array", testCases: [{ ok: 1 }] }, KEYS))
      .toEqual([{ ok: 1 }]);
  });

  it("requires the preferred key's value to actually be an array", () => {
    expect(unwrapArray({ testCases: 42 }, KEYS)).toBeUndefined();
  });

  it("a nested-array value is a valid array (arrays of arrays are still arrays)", () => {
    expect(unwrapArray({ testCases: [[1], [2]] }, KEYS)).toEqual([[1], [2]]);
  });
});

describe("unwrapArray — single-key object fallback", () => {
  it("unwraps an object whose only key holds an array, whatever the key is called", () => {
    expect(unwrapArray({ data: [{ x: 1 }] }, KEYS)).toEqual([{ x: 1 }]);
    expect(unwrapArray({ anything: [1, 2] }, KEYS)).toEqual([1, 2]);
  });

  it("rejects an object with several keys when none is a preferred array", () => {
    expect(unwrapArray({ data: [{ x: 1 }], other: "y" }, KEYS)).toBeUndefined();
  });

  it("rejects a single-key object whose one value is not an array", () => {
    expect(unwrapArray({ nope: "scalar" }, KEYS)).toBeUndefined();
  });
});

describe("unwrapArray — rejects everything else", () => {
  it("rejects primitives, null and non-array objects", () => {
    expect(unwrapArray('[{ "a": 1 }]', KEYS)).toBeUndefined();  // a STRING is not an array
    expect(unwrapArray(null, KEYS)).toBeUndefined();
    expect(unwrapArray(undefined, KEYS)).toBeUndefined();
    expect(unwrapArray(42, KEYS)).toBeUndefined();
    expect(unwrapArray({}, KEYS)).toBeUndefined();
  });

  it("with no preferred keys, falls straight to the single-key rule", () => {
    expect(unwrapArray([1], [])).toEqual([1]);
    expect(unwrapArray({ only: [1] }, [])).toEqual([1]);
    expect(unwrapArray({ a: [1], b: 2 }, [])).toBeUndefined();
  });
});