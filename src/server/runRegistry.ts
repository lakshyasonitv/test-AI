import type { StageEvent } from "../orchestrator.js";
import type { Response } from "express";
import { store } from "../runStore.js";

// Live SSE fan-out only. History/durability now lives in the RunStore (../runStore),
// so this holds just the open connections per run — nothing that matters is lost on
// restart. A reconnecting browser replays the full run from disk, then streams live.
const subscribers = new Map<string, Set<Response>>();

/** Broadcast a live event to any open connections. Durability is the orchestrator's
 *  job (it appends to the RunStore before calling back), so this only pushes. */
export function record(event: StageEvent): void {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers.get(event.runId) ?? []) res.write(line);
}

/** Attach an SSE response: replays durable history from the store, then streams live. */
export function subscribe(runId: string, res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const e of store.read(runId)) res.write(`data: ${JSON.stringify(e)}\n\n`);

  let set = subscribers.get(runId);
  if (!set) { set = new Set(); subscribers.set(runId, set); }
  set.add(res);
  res.on("close", () => set!.delete(res));
  // ponytail: tiny replay/live gap — an event fired between the disk replay above and
  // this subscribe is missed live, but it's on disk, so any reconnect shows the full
  // history. Buffer only if a stuck-stage bug actually shows up. (Same gap the original had.)
}

export function getEvents(runId: string): StageEvent[] {
  return store.read(runId);
}
