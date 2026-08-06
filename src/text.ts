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
