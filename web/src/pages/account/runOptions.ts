import { useEffect, useState } from "react";
import { loadHealth } from "./identity";

/**
 * The Settings "Run behaviour" toggles (app.js runOptions / optionDefaults). Per-run request
 * options, not persisted server settings, and held in memory only, exactly as app.js does.
 *
 * Only keys the user actually toggled are sent: `runOptions()` is the object a new-run composer
 * spreads into POST /api/runs `options`, so an untouched toggle leaves the server on its own
 * env-configured default. Defaults come from GET /api/health `defaults` (TD-83).
 */
export type RunOptionKey = "gateReview" | "selfHeal";

const chosen: Partial<Record<RunOptionKey, boolean>> = {};
const defaults: Record<RunOptionKey, boolean> = { gateReview: false, selfHeal: false };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

void loadHealth().then((h) => { Object.assign(defaults, h.defaults); notify(); });

/** Exactly app.js's `runOptions`: only the toggled keys. */
export const runOptions = (): Partial<Record<RunOptionKey, boolean>> => ({ ...chosen });

export const runOptionValue = (key: RunOptionKey): boolean => (key in chosen ? !!chosen[key] : defaults[key]);

export function toggleRunOption(key: RunOptionKey): void {
  chosen[key] = !runOptionValue(key);
  notify();
}

/** Re-renders the caller whenever a toggle or the server defaults change. */
export function useRunOptions(): (key: RunOptionKey) => boolean {
  const [, setN] = useState(0);
  useEffect(() => {
    const l = () => setN((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return runOptionValue;
}
