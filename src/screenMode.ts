/**
 * SCREEN_MODE_ALL_SITES (DECISIONS.md D-85, default off). Its own module because three stages read it —
 * ir.ts (grounding), targetResolver.ts (the grounding replay) and generator.ts (the emitted spec) — and the
 * last two must not import ir.ts. Off, every one of them behaves exactly as before the flag existed.
 */
export function screenModeAllSites(): boolean {
  return process.env.SCREEN_MODE_ALL_SITES === "true";
}
