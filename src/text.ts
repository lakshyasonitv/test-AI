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
