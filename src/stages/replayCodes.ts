/**
 * The run-token codes the grounding replays of a run used, kept per run. Its own module so a test that
 * replaces liveExtend with a fake still has it.
 */
import type { Step } from "../schema/ir.js";
import { newRunTokenContext } from "../text.js";
import { currentRunId } from "../runContext.js";

/**
 * The run-token codes the grounding replays of a run used. A replay that clicks Save makes a real record
 * ("Ruiz uqzh6b", run 2026-11-13T16-00-53-324Z-9f8e022d), which the spec's own record tracking never sees:
 * two Contacts were left in the org, and the run's own Save then met the duplicate rule. Cleanup deletes the
 * records named with exactly these codes (salesforceCleanup.replayMade).
 */
const replayCodesByRun = new Map<string, Set<string>>();
export function replayContext() {
  const ctx = newRunTokenContext();
  const run = currentRunId();
  if (run) { if (!replayCodesByRun.has(run)) replayCodesByRun.set(run, new Set()); replayCodesByRun.get(run)!.add(ctx.uid); }
  return ctx;
}
/** A step named after a record a replay made ("Quasar Robotics za3lt6"): the code goes back to {{uid}} (the
 *  run makes its own record, and cleanup deletes the replay's), and a position-only selector found on the
 *  replay's page goes with it. Run 2026-11-13T16-58-36-613Z-a34e9804 clicked the replay's name and failed. */
export function restoreReplayCodes(steps: Step[], codes: string[]): string[] {
  const notes: string[] = [];
  const valid = codes.filter((c) => /^[a-z0-9]{4,12}$/.test(c));
  for (const s of valid.length ? steps : []) {
    for (const key of ["name", "text"] as const) {
      const v = s.target?.[key];
      if (typeof v !== "string") continue;
      const code = valid.find((c) => new RegExp(`(^|[^A-Za-z0-9])${c}([^A-Za-z0-9]|$)`).test(v));
      if (!code) continue;
      s.target = { ...s.target!, [key]: v.replace(code, "{{uid}}"), css: undefined };
      notes.push(`${s.id}: "${v}" named a record a grounding replay made -> "${s.target[key]}", the run's own`);
    }
    if (typeof s.value === "string") {
      const code = valid.find((c) => new RegExp(`(^|[^A-Za-z0-9])${c}([^A-Za-z0-9]|$)`).test(s.value!));
      if (code) s.value = s.value.replace(code, "{{uid}}");
    }
  }
  return notes;
}

/** The codes this run's replays have used so far (kept). */
export function peekReplayCodes(runId: string): string[] {
  return [...(replayCodesByRun.get(runId) ?? [])];
}
/** The codes this run's replays used, forgotten once read. */
export function takeReplayCodes(runId: string): string[] {
  const codes = [...(replayCodesByRun.get(runId) ?? [])];
  replayCodesByRun.delete(runId);
  return codes;
}
