import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { irFileForRunCase } from "../src/server/library.js";

/**
 * Session 102: a case that self-healed has two IRs on disk — the one that failed (04-ir.json) and
 * the one that passed (healed/ir.json). Saving it to the library must take the healed one, or the
 * saved suite replays the failure.
 */
describe("irFileForRunCase", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "zq-runs-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const touch = (...p: string[]) => { mkdirSync(path.dirname(path.join(root, ...p)), { recursive: true }); writeFileSync(path.join(root, ...p), "{}"); };

  it("prefers the healed IR of a suite case, then its own IR", () => {
    touch("r1", "cases", "case-1", "04-ir.json");
    expect(irFileForRunCase("r1", "case-1", root)).toBe(path.join(root, "r1", "cases", "case-1", "04-ir.json"));
    touch("r1", "cases", "case-1", "healed", "ir.json");
    expect(irFileForRunCase("r1", "case-1", root)).toBe(path.join(root, "r1", "cases", "case-1", "healed", "ir.json"));
  });

  it("for the primary case, the run-level healed IR beats the run-level IR; other cases never take it", () => {
    touch("r2", "04-ir.json");
    touch("r2", "healed", "ir.json");
    expect(irFileForRunCase("r2", "case-0", root)).toBe(path.join(root, "r2", "healed", "ir.json"));
    expect(irFileForRunCase("r2", "case-3", root)).toBe(path.join(root, "r2", "04-ir.json"));
  });

  it("null when the run left nothing", () => {
    expect(irFileForRunCase("nope", "case-0", root)).toBeNull();
  });
});
