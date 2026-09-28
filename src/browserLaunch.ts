import { AsyncLocalStorage } from "node:async_hooks";

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

/**
 * The locales a RUN may ask for, as an allow-list.
 *
 * Exists because `POST /api/runs` takes a locale from an untrusted body and the route must not
 * forward a raw string into a browser option — same reason `VALID_COVERAGE` is a literal array in
 * `server/index.ts` rather than a free-text field. Defined HERE, beside the helper that consumes
 * the value, so the route and the browser cannot disagree about what is acceptable.
 *
 * Deliberately short. It is an allow-list, not a catalogue: every entry is a tag someone has a
 * reason to test against, and adding one is a one-line change. `RUN_LOCALE` is NOT checked against
 * it — that is operator-set environment, trusted the same way `CHROMIUM_EXTRA_ARGS` above is, and
 * an operator who needs `sv-SE` should not have to ship a code change to get it.
 */
export const SUPPORTED_RUN_LOCALES = [
  "en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT",
  "pt-BR", "nl-NL", "ja-JP", "ko-KR", "zh-CN", "hi-IN",
] as const;

export type SupportedRunLocale = typeof SUPPORTED_RUN_LOCALES[number];

/** True for a locale a request is allowed to ask for. Used by the route; see the list's docblock. */
export function isSupportedRunLocale(v: unknown): v is SupportedRunLocale {
  return typeof v === "string" && (SUPPORTED_RUN_LOCALES as readonly string[]).includes(v);
}

/**
 * This run's requested locale, carried ambiently.
 *
 * WHY A RAIL AND NOT A PARAMETER. Locale has to reach four browser-opening sites that sit behind
 * different call chains — domDiscovery's extractor, hybridDiscovery's vision fallback, its
 * authenticated crawl, and liveExtend's replay — plus `toIR`, `caseEdit` and `stepText`, which
 * reach the last of those without knowing a browser is involved. Threading a parameter through
 * every function in between would touch a dozen signatures to deliver one string.
 *
 * `llmContext.ts` faced exactly this and records the answer: this codebase already solved it twice
 * with `AsyncLocalStorage` — once for the per-run LLM budget (`llmBudget.ts`), once for the per-run
 * LLM config. Its docblock's reasoning applies here word for word: the store "scopes to the async
 * causal chain the call entered from, not to the process", so it is safe across
 * MAX_CONCURRENT_RUNS by construction and does not reintroduce a module-level singleton. This is
 * the same rail, entered in the same place in `orchestrator.ts`, for the same reason.
 *
 * ABSENT MEANS ENV. Outside a run that entered one — the CLI, a unit test, the editor routes —
 * `currentRunLocale()` is null and resolution falls back to `RUN_LOCALE` and then to the default,
 * which is exactly what a process-wide setting would have done.
 */
const runLocaleContext = new AsyncLocalStorage<string>();

/**
 * Make `locale` the locale for every browser opened later in this async causal chain.
 *
 * `enterWith`, not a wrapping callback, for the reason `llmBudget.ts` gives: it applies to the rest
 * of the current execution without the orchestrator having to nest its whole body inside a
 * callback. Called beside `enterWithBudget` / `enterWithLlmConfig`.
 */
export function enterWithRunLocale(locale: string): void {
  runLocaleContext.enterWith(locale);
}

/** The ambient run locale, or null outside any run that entered one. */
export function currentRunLocale(): string | null {
  return runLocaleContext.getStore() ?? null;
}

/**
 * Run `fn` with `locale` ambient, and leave it behind on the way out.
 *
 * `enterWithRunLocale` above deliberately does NOT unwind — that is what lets the orchestrator set
 * it once for a whole run without nesting. The cost is that it also leaks to everything else that
 * shares the async context afterwards, which in a test process is the next test.
 * `tests/apiContract.test.ts` documents that exact class of flake for `process.env`: vitest can run
 * several files in one worker, so state one file sets is state another file inherits, and the
 * symptom is a different test failing each run. This is the scoped form for anything that must not
 * do that.
 */
export function withRunLocale<T>(locale: string, fn: () => T): T {
  return runLocaleContext.run(locale, fn);
}

/** The default when nothing asks for anything else. */
const DEFAULT_LOCALE = "en-US";
/** UTC, not the host zone: a rendered date must not depend on which machine discovered the page. */
const DEFAULT_TIMEZONE = "UTC";

export interface BrowserContextLocaleOptions {
  locale: string;
  timezoneId: string;
}

/**
 * Locale, timezone and Accept-Language for every browser context this project opens.
 *
 * WHY THIS EXISTS. Nothing pinned any of these, so each of the five consumers inherited the HOST's
 * locale: whatever a container image happened to set, or whatever Chromium happened to send. On a
 * site that content-negotiates, discovery then extracted the negotiated language into
 * `AppModel.pages[].elements`, and every later stage inherited it — case titles, IR targets,
 * generated locators. A run that produced Korean test cases is the recorded symptom, and the model
 * was not at fault: it described the page it was shown.
 *
 * So the fix belongs at the browser, not in a prompt. A prompt rule asking for English output is a
 * preference (CLAUDE.md's central rule) and would have left the AppModel, the locators and the
 * executed spec in the negotiated language regardless.
 *
 * WHY ONE HELPER, the same argument `chromiumLaunchOptions` above makes: pinning only some of the
 * five consumers is worse than pinning none, because a spec generated against one locale and
 * executed against another produces locator failures that look like product bugs.
 *
 * ACCEPT-LANGUAGE COMES FROM `locale`, AND CANNOT BE SET ALONGSIDE IT. This was written first as
 * `locale` plus an explicit `extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" }`, on the
 * reasoning that what the site receives should be visible here rather than emergent. Measured
 * against a real Chromium on the pinned 1.49.0, that is a silent no-op — `locale` wins and the
 * explicit header is discarded:
 *
 *     locale only                 -> Accept-Language: fr-FR
 *     extraHTTPHeaders only       -> Accept-Language: fr-FR,fr;q=0.9
 *     both, header differs        -> Accept-Language: fr-FR      <- ours dropped
 *     both, header = derived      -> Accept-Language: fr-FR      <- ours dropped
 *     neither                     -> no Accept-Language at all
 *
 * So the header is pinned by pinning `locale`, and setting it a second time would only look like
 * it was doing something — `DECISIONS.md` D-19's whole point, and the same shape as
 * `.filter({ visible: true })`. `tests/browserLocale.test.ts` pins both halves: that a pinned
 * locale produces the bare tag, and that an explicit header loses to it, so nobody re-adds one.
 *
 * The one behavioural consequence: the header is `fr-FR`, not the `fr-FR,fr;q=0.9` q-list a real
 * browser sends. It is valid, unambiguous, and not something this code can change while `locale`
 * is set — the alternative (header without `locale`) would leave `navigator.language` and number
 * and date formatting on the host's, which is most of what is being fixed.
 *
 * RESOLUTION: explicit argument → the ambient run locale → `RUN_LOCALE` → "en-US".
 * Timezone is `RUN_TIMEZONE`, default "UTC".
 *
 * `RUN_LOCALE=""` — explicitly empty, not merely unset — returns `{}`, which is byte-identical to
 * the pre-change behaviour: host-inherited, nothing pinned. That is the rollback switch, and it is
 * why defaulting this ON is safe. Unlike an ordinary new capability, the behaviour being replaced
 * here is not a baseline anyone chose — it is host-dependent and differs between machines for the
 * same site — so there is no prior behaviour worth preserving by default, only an unspecified
 * variable. The escape hatch is what keeps that reversible.
 */
export function browserContextOptions(locale?: string): BrowserContextLocaleOptions | Record<string, never> {
  const raw = locale ?? currentRunLocale() ?? process.env.RUN_LOCALE;
  // Explicitly empty disables pinning entirely. `undefined` (unset) is NOT the same thing and
  // falls through to the default — an unset var must not silently mean "unpinned", or the fix
  // would be off by default on every machine that has not been configured.
  if (raw !== undefined && raw.trim() === "") return {};
  const resolved = (raw ?? DEFAULT_LOCALE).trim() || DEFAULT_LOCALE;
  return {
    locale: resolved,
    timezoneId: process.env.RUN_TIMEZONE?.trim() || DEFAULT_TIMEZONE,
  };
}

/**
 * The locale/timezone pair as a CACHE-KEY part.
 *
 * Both disk caches outlive a change of locale, and neither would otherwise notice one:
 *
 *   - `kb/cache.ts` keys a discovered AppModel on `sha1(url)` alone. Its 30-minute TTL means a
 *     wrong-locale model self-heals eventually, but "eventually" is still a window in which a
 *     Korean snapshot is served to an en-US run.
 *   - `liveExtend.ts`'s walk cache carries neither the locale nor any page content, and
 *     `llmCache.ts` states its disk half never expires at all. TD-85 is the same shape already
 *     having happened once, with credentials instead of locale.
 *
 * The three LLM keys that DO matter (`hybridDiscovery`'s labels, `testCases`, `ir`) already carry
 * the page content or the AppModel itself, so they re-key themselves the moment discovery output
 * changes and need nothing added — see `docs/FINDINGS_2026-09-28.md` §7.4. Adding a dimension to
 * all seven call sites would be noise; these two are the real exposures.
 *
 * Returns "system" when pinning is off, so an unpinned entry and an en-US entry are still
 * different keys rather than colliding.
 */
export function localeCacheDimension(locale?: string): string {
  const opts = browserContextOptions(locale);
  if (!("locale" in opts)) return "system";
  return `${opts.locale}|${opts.timezoneId}`;
}
