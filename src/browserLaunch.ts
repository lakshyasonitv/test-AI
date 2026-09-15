/**
 * Centralised Chromium launch options for every browser this process opens: the four in-process
 * `chromium.launch()` calls (domDiscovery, hybridDiscovery x2, liveExtend) and the generated
 * spec's runner (playwright.config.ts `use.launchOptions`).
 *
 * Behaviour byte-identical when CHROMIUM_EXTRA_ARGS is unset or empty: the returned array is
 * `[]`, which is what `chromium.launch()` receives by default.  When set, the space-separated
 * value is split into individual flags, so every consumer gets the same flags in the same order.
 *
 * Why a single helper instead of inlining: a misconfiguration that passes `--no-sandbox` to
 * only some of the five consumers is worse than missing it entirely — a later consumer's sandbox
 * failure masks the pass in an earlier one.
 */

export function chromiumLaunchOptions(): { args: string[] } {
  const raw = process.env.CHROMIUM_EXTRA_ARGS?.trim();
  if (!raw) return { args: [] };
  return { args: raw.split(/\s+/).filter(Boolean) };
}
