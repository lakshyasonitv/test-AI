import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { enterWithRunId, currentRunId, withRunId } from "../src/runContext.js";
import { runIdEnv, executorRunTag } from "../src/stages/executor.js";
import { llmCallLine } from "../src/llm/client.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const USAGE = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

const SRC = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

describe("run-id rail (behavioural)", () => {
  it("is null outside any run", () => {
    expect(currentRunId()).toBeNull();
  });

  it("enterWithRunId is visible to awaited work and contained by a withRunId scope", async () => {
    expect(currentRunId()).toBeNull();
    await withRunId("outer", async () => {
      enterWithRunId("inner");
      await tick();
      expect(currentRunId()).toBe("inner");
    });
    // enterWith deliberately does not unwind on its own; the enclosing run() scope is what keeps
    // it from leaking into whatever runs next in this worker.
    expect(currentRunId()).toBeNull();
  });

  it("two concurrent withRunId scopes never see each other's id", async () => {
    const seen: string[] = [];
    await Promise.all([
      withRunId("A", async () => { await tick(); await tick(); seen.push(currentRunId() ?? "null"); }),
      withRunId("B", async () => { await tick(); seen.push(currentRunId() ?? "null"); await tick(); }),
    ]);
    expect(seen.sort()).toEqual(["A", "B"]);
  });

  it("withRunId leaves no id behind once it returns", () => {
    const inside = withRunId("run-123", () => currentRunId());
    expect(inside).toBe("run-123");
    expect(currentRunId()).toBeNull();
  });

  it("withRunId(null/undefined) runs fn with no ambient id instead of entering an empty string", () => {
    let inside: string | null = "sentinel";
    const r = withRunId(null, () => { inside = currentRunId(); return 5; });
    expect(r).toBe(5);
    expect(inside).toBeNull();
    let inside2: string | null = "sentinel";
    withRunId(undefined, () => { inside2 = currentRunId(); });
    expect(inside2).toBeNull();
  });

  it("the store is genuinely per-chain, not a module global", async () => {
    const store = new AsyncLocalStorage<string>();
    expect(store.getStore()).toBeUndefined();
    await store.run("x", async () => { await tick(); expect(store.getStore()).toBe("x"); });
    expect(store.getStore()).toBeUndefined();
  });
});

describe("runIdEnv — the Playwright child boundary", () => {
  it("is empty outside a run and carries the id inside one", () => {
    expect(runIdEnv()).toEqual({});
    withRunId("run-123", () => expect(runIdEnv()).toEqual({ RUN_ID: "run-123" }));
    expect(runIdEnv()).toEqual({});
  });
});

/**
 * The leak class `browserLaunch.ts:86-96` warns about: a rail entered with `enterWith` does not
 * unwind, so a value set for one run can surface on a line emitted for another — or after the
 * first finished. The existing rail tests above check `currentRunId()` in isolation; these check
 * the thing that actually matters, the EMITTED LINE, under concurrency and after exit.
 */
describe("leak containment — a line never carries another run's id", () => {
  it("two runs emitting concurrently each tag their own lines, never both ids on one line", async () => {
    const lines: string[] = [];
    await Promise.all([
      withRunId("run-A", async () => {
        await tick();
        lines.push(executorRunTag() + "A-line");
        lines.push(llmCallLine("main", "gemini:m", USAGE, currentRunId()));
      }),
      withRunId("run-B", async () => {
        lines.push(executorRunTag() + "B-line");
        await tick();
        lines.push(llmCallLine("main", "gemini:m", USAGE, currentRunId()));
      }),
    ]);

    // Each run's own emitted line carries its own id (directly asserts the tag is not a no-op)...
    expect(lines.find((l) => l.endsWith("A-line"))).toContain("run-A");
    expect(lines.find((l) => l.endsWith("B-line"))).toContain("run-B");
    // ...and no single line ever carries both, which is what a leaked ambient store would produce.
    for (const l of lines) expect(l.includes("run-A") && l.includes("run-B")).toBe(false);
  });

  it("after a run's scope returns, a line emitted carries no id at all", () => {
    withRunId("run-A", () => { /* the run does its work and finishes */ });
    // If withRunId ever regressed to `enterWith`, "run-A" would still be ambient here and leak
    // onto this line — the browserLaunch.ts flake, reproduced at the log boundary.
    expect(executorRunTag()).toBe("");
    expect(llmCallLine("main", "gemini:m", USAGE, currentRunId())).not.toContain("run-A");
    expect(currentRunId()).toBeNull();
  });
});

describe("wiring (source guards)", () => {
  it("the pipeline enters the rail for the whole run", () => {
    // Line-anchored so a commented-out call does not count as present.
    expect(SRC("orchestrator.ts")).toMatch(/^\s*enterWithRunId\(runId\);/m);
  });

  it("the executor hands the run id to the child process", () => {
    expect(SRC("stages/executor.ts")).toMatch(/^\s*\.\.\.runIdEnv\(\),/m);
  });

  it("the executor also tags its OWN parent-side lines, not only the child's env", () => {
    const ex = SRC("stages/executor.ts");
    // A console call whose FIRST argument is a string literal (not executorRunTag()) is untagged.
    // runIdEnv only covers the child; these lines are printed by the parent, which holds the rail.
    const untagged = ex.split("\n").filter((l) => /console\.(log|error)\(\s*[`"]/.test(l));
    expect(untagged).toEqual([]);
    expect(ex).toMatch(/^export function executorRunTag\(\)/m);
  });

  it("the editor routes use the scoped form, never enterWith", () => {
    const index = SRC("server/index.ts");
    expect(index).toContain("withRunId(req.params.runId,");
    expect(index).toContain("withRunId(found.sourceRunId,");
    // A request handler that entered with `enterWith` would leak into the next request.
    expect(index).not.toContain("enterWithRunId");
  });
});
