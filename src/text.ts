/**
 * Cut a block of text down to `maxChars` at the last line/paragraph break at or
 * before the limit, appending a note when anything was dropped. Unlike a blind
 * `slice`, a sentence, heading, or table row always survives intact — the cut
 * only ever happens between lines.
 */
export function cutAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  let cut = head.lastIndexOf("\n");
  if (cut < maxChars * 0.6) cut = head.lastIndexOf(" ");
  if (cut < maxChars * 0.6) cut = -1;
  const kept = cut >= 0 ? head.slice(0, cut) : head;
  const dropped = text.length - kept.length;
  return `${kept}\n... (${dropped} more chars omitted)`;
}

/**
 * The host of a URL, normalised for "is this the same site?" comparisons: lowercased, with a
 * leading `www.` removed. Scheme and port are deliberately not part of it.
 *
 * ONE definition, three consumers — `isSameSite` (executor.ts), and `pageKey`/`navUrlAllowed`
 * (ir.ts). It lives in this neutral module rather than being exported from `executor.ts` so a
 * pure grounding stage does not have to import the process-spawning one, and so the two cannot
 * drift apart the way TD-07 records.
 *
 * WHY IT EXISTS AT ALL. A user types `http://example.com`; the site redirects to `https://…`.
 * Every URL discovery records is then `https://`, while the entered scheme survives in
 * `appModel.baseUrl`. Any comparison that includes the scheme then says the app's own pages are
 * a different site. That mistake has now been made twice in this codebase: `detectBlocked`
 * reported correct runs as having "left the application" (TD-69), and the IR navigate guard
 * rejected a path while its own error message listed that path as known (TD-82).
 *
 * Returns null when the URL cannot be parsed; every caller treats that as "cannot tell" and
 * falls to its own permissive side.
 */
export function siteHost(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return null; }
}

/**
 * A URL reduced to "which page is this?" — normalised host plus path, ignoring scheme, port,
 * `www.`, query and hash.
 *
 * Lives here, beside `siteHost`, because three stages need it and two of them cannot import each
 * other: `ir.ts` already imports `liveExtend.ts`, so the reverse would be a cycle. One definition
 * in a neutral module is also what stops the two copies drifting the way TD-07 records.
 *
 * Query is deliberately out: a post-login redirect that only adds `?next=/dashboard` is the same
 * page, and a tracking parameter must not make a discovered page unrecognisable.
 */
export function pageKey(url: string): string {
  const host = siteHost(url);
  if (!host) return url;
  try {
    return host + (new URL(url).pathname.replace(/\/+$/, "") || "/");
  } catch { return url; }
}

/**
 * A line compared by its words only: letters and digits, lowercased. The model's markdown and the
 * page's text differ in decoration — the model dropped an aria-hidden "*" and markdown escapes
 * punctuation ("= Required Information" vs "* = Required Information", run
 * 2026-10-24T14-53-11-800Z-86059d19) — while the words are the same line.
 */
export function lineKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * `{{uid}}` in a fill value: replaced by a short unique code where the value is typed (the spec once
 * per run, the grounding replay per fill), so a create flow never repeats a record name. Orgs with
 * duplicate rules block a repeat ("Similar Records Exist", run 2026-10-24T14-53-11-800Z-86059d19).
 */
export const UNIQUE_TOKEN = "{{uid}}";

/**
 * Run tokens (Session 102j). Values a saved test must not freeze: a saved suite that typed the same
 * phone on every replay tripped duplicate matching, and a date written when the IR was compiled goes
 * stale. Each token is resolved WHERE THE VALUE IS TYPED — the spec once per run, the grounding replay
 * per fill — never at compile time:
 *   {{uid}}                 a short unique code
 *   {{phone}}               a 10-digit phone whose last four digits are the run's
 *   {{date:+30:en-US}}      today plus 30 days, written the way that locale writes a short date
 *                           (Lightning parses a typed date in the USER's locale, so the org's user
 *                           locale rides in the token)
 */
export const PHONE_TOKEN = "{{phone}}";
export function dateToken(days: number, locale: string): string {
  return `{{date:${days >= 0 ? "+" : ""}${days}:${locale}}}`;
}
const RUN_TOKEN_RE = /\{\{(uid|phone|date:([+-]?\d+):([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*))\}\}/g;
export function hasRunToken(value: string | undefined): boolean {
  return !!value && new RegExp(RUN_TOKEN_RE.source).test(value);
}
export interface RunTokenContext { uid: string; phone: string; now?: number }
/**
 * The resolver as SOURCE, self-contained, so the generated spec runs the same characters the replay
 * does (TD-07): generator.ts interpolates it, text.ts evaluates it below.
 */
export const RESOLVE_RUN_TOKENS_JS = `(value, ctx) => value.replace(
  /\\{\\{(uid|phone|date:([+-]?\\d+):([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*))\\}\\}/g,
  (_m, kind, days, locale) => {
    if (kind === "uid") return ctx.uid;
    if (kind === "phone") return ctx.phone;
    const d = new Date((ctx.now || Date.now()) + Number(days) * 86400000);
    try {
      return new Intl.DateTimeFormat(String(locale || "en-US").replace("_", "-"), { year: "numeric", month: "numeric", day: "numeric" }).format(d);
    } catch (e) {
      return (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear();
    }
  })`;
export const resolveRunTokens = new Function(`return (${RESOLVE_RUN_TOKENS_JS});`)() as
  (value: string, ctx: RunTokenContext) => string;
/** A fresh context for one run or one replayed fill. */
export function newRunTokenContext(): RunTokenContext {
  const uid = Math.random().toString(36).slice(2, 8);
  return { uid, phone: "415555" + String(Date.now()).slice(-4) };
}

/**
 * A number as a page shows it ("$5,000.00", "5.000,00 €", "10%", "USD 1,200"), else null. As SOURCE,
 * so the spec's field check (generator.ts SF_FIELD_MATCH_JS) and the IR pass that decides what is a
 * field's value (salesforceGuidance.fieldChecksOnRecordView) read numbers the same way (TD-07).
 */
export const SHOWN_NUMBER_JS = `(s) => {
  const t = String(s).replace(/\\b[A-Z]{3}\\b|[$\\u20ac\\u00a3\\u00a5\\u20b9%\\s\\u00a0]/g, "").replace(/[.,]+$/, "");
  if (!/^[-+]?\\d[\\d.,]*$/.test(t)) return null;
  const dot = t.lastIndexOf("."), comma = t.lastIndexOf(",");
  let dec = dot > comma ? "." : comma > dot ? "," : "";
  // One kind of separator with three digits after it ("5,000", "1.000.000") groups thousands.
  if (dec && (dot < 0 || comma < 0) && (t.split(dec).length > 2 || t.length - t.lastIndexOf(dec) === 4)) dec = "";
  const at = dec ? t.lastIndexOf(dec) : t.length;
  const n = Number(t.slice(0, at).replace(/[.,]/g, "") + (dec ? "." + t.slice(at + 1) : ""));
  return Number.isFinite(n) ? n : null;
}`;
export const shownNumber = new Function(`return (${SHOWN_NUMBER_JS});`)() as (s: string) => number | null;
