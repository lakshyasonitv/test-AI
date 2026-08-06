import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { store } from "../src/runStore.js";

const runsRoot = path.join("runs");

// Deterministic: "2000-…" predates the current process (always "dead"), "2999-…" postdates
// it (always "alive"), so the test doesn't depend on wall-clock timing of module load.
const OLD_RUN = "2000-01-01T00-00-00-000Z-aaaa1111";
const NEW_RUN = "2999-01-01T00-00-00-000Z-aaaa1111";

function writeEvents(runId: string, events: unknown[]) {
  mkdirSync(path.join(runsRoot, runId), { recursive: true });
  writeFileSync(
    path.join(runsRoot, runId, "events.ndjson"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
}

afterEach(() => {
  for (const id of [OLD_RUN, NEW_RUN]) {
    if (existsSync(path.join(runsRoot, id))) rmSync(path.join(runsRoot, id), { recursive: true, force: true });
  }
});

describe("runStore orphaned-run detection", () => {
  it("closes a pre-boot run's event stream with a synthetic error", () => {
    writeEvents(OLD_RUN, [
      { runId: OLD_RUN, stage: "plan", status: "completed", data: {}, ts: 1 },
    ]);
    const events = store.read(OLD_RUN);
    expect(events[events.length - 1]).toMatchObject({
      stage: "error",
      status: "failed",
    });
    expect(events[events.length - 1].error).toContain("server restarted");
  });

  it("leaves a run started in this process alone even when it has no terminal event yet", () => {
    writeEvents(NEW_RUN, [
      { runId: NEW_RUN, stage: "execute", status: "started", data: {}, ts: 1 },
    ]);
    const events = store.read(NEW_RUN);
    expect(events[events.length - 1].stage).toBe("execute");
  });

  it("does not touch a stream that already ended normally", () => {
    writeEvents(NEW_RUN, [
      { runId: NEW_RUN, stage: "execute", status: "completed", data: {}, ts: 1 },
      { runId: NEW_RUN, stage: "done", status: "completed", data: { passed: true }, ts: 2 },
    ]);
    const events = store.read(NEW_RUN);
    expect(events.map((e) => e.stage)).toEqual(["execute", "done"]);
  });
});
