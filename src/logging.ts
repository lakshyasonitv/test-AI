/**
 * The single switch for Phase 2's new diagnostic OUTPUT — the per-call provider/model/token line,
 * the per-run token summary, and the widened `[startup]` block.
 *
 * Default OFF, and off means NO new line is emitted anywhere: with the flag unset the process logs
 * exactly what it logged before this file existed. That is what keeps the nine phase reports'
 * "startup log is byte-identical" gates true without touching them, and it is `AGENTS.md` rule 2:
 * a new capability ships behind a flag that defaults to off.
 *
 * The FIXES from the same phase — credential redaction, the corrected misleading lines — are
 * deliberately NOT behind this flag. A log line that asserts something false is a defect, and no
 * code parses log text (`AGENTS.md` L2b), so there is nobody to break by correcting it. See
 * `DECISIONS.md` for the full reasoning.
 */
export function extendedLoggingEnabled(): boolean {
  return process.env.EXTENDED_LOGGING === "true";
}
