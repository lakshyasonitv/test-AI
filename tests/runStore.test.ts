import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { store } from "../src/runStore.js";

// Regression: a run whose events.ndjson has no terminal (done/error) event and whose id
// predates this server process died when the PREVIOUS process was killed/restarted — no
// orchestrator promise is still alive to ever write the missing event, so without this the
// frontend polls it forever. A run started in THIS process with no terminal event yet is
// still legitimately in progress and must be left alone.
describe("runStore — orphaned run detection", () => {
  const ids: string[] = [];
  afterEach(() => {
    for (const id of ids) rmSync(path.join("runs", id), { recursive: true, force: true });
    ids.length = 0;
  });

  const write = (runId: string, events: object[]) => {
    const dir = path.join("runs", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8"
    );
    ids.push(runId);
  };

  it("closes a non-terminal run whose id predates this process with a synthetic error", () => {
    const runId = "2000-01-01T00-00-00-000Z-deadbeef"; // long before this test process started
    write(runId, [{ runId, stage: "input", status: "completed", data: {}, ts: 1 }]);

    const events = store.read(runId);
    const last = events[events.length - 1];
    expect(last.stage).toBe("error");
    expect(last.data).toEqual({});
  });

  it("leaves a non-terminal run whose id postdates this process alone", () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString().replace(/[:.]/g, "-");
    const runId = `${future}-cafebabe`;
    write(runId, [{ runId, stage: "input", status: "completed", data: {}, ts: 1 }]);

    const events = store.read(runId);
    const last = events[events.length - 1];
    expect(last.stage).toBe("input");
  });
});
