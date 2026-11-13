/**
 * "Why it stopped": one plain sentence per case for the downloaded HTML report.
 *
 * WHY. The report used to show Playwright's raw error ("locator.click: Timeout 10000ms exceeded")
 * plus a long call log. The real reason was usually in that log, but buried: a Search button that
 * was covered by the search box's own dropdown read as "the step exceeded its timeout". This turns
 * the error into one sentence a tester can act on.
 *
 * WHAT IT READS. Only things already saved for the run: the case's status, its saved blocked
 * reason, its saved truncation note, and Playwright's own error text. The error text is written by
 * Playwright, not by a model or the page, so matching its fixed phrases is safe (the same thing
 * classify.ts does). The truncation note is shown as-is, never matched (see the IR schema comment).
 *
 * SAFE BY DESIGN. Report only: nothing in running, healing or diagnosing a test calls this. It
 * returns null when it has nothing sure to say, and the report then looks exactly as before.
 *
 * PURE CODE, NO MODEL, NO I/O.
 */

export interface StopReasonInput {
  /** passed | failed | blocked | truncated | truncated_no_assertion */
  status: string;
  /** Saved by the suite runner when a block wall (code by email, captcha...) stopped the case. */
  blockedBy?: string;
  /** The IR's truncationNote: why the test was cut short when it was built. */
  truncationNote?: string;
  /** Playwright's full error text for the failing step. */
  errorText?: string;
  /** The failing step's title, e.g. "Click 'SetupOpens in a new tab'". */
  failedStepTitle?: string;
  /** The failing step's IR target, if the IR was saved. */
  target?: { role?: string; name?: string; label?: string; text?: string; placeholder?: string; field?: string } | null;
  /** How many steps the test has (for "cut short after step N"). */
  stepCount?: number;
}

/**
 * Salesforce (and others) add a hidden screen-reader hint to a link's name, so the "Setup" button
 * is named "SetupOpens in a new tab". Show the name a person sees.
 */
export function cleanName(name: string): string {
  return name.replace(/\s*\(?Opens in a new (tab|window)\)?\s*$/i, "").trim();
}

/** The thing the step acted on, in words: `the "Setup" button`, or `the element` if unknown. */
function thingName(input: StopReasonInput): string {
  const t = input.target ?? {};
  let name = t.name || t.label || t.field || t.text || t.placeholder || "";
  if (!name && input.failedStepTitle) {
    // Step titles quote their target: Click 'Search', Assert 'X' is visible.
    const m = input.failedStepTitle.match(/'([^']+)'/);
    if (m) name = m[1];
  }
  name = cleanName(name);
  if (!name) return "the element";
  const kind = t.role === "button" ? " button"
    : t.role === "link" ? " link"
    : t.role === "textbox" || t.role === "searchbox" ? " box"
    : "";
  return `the "${name}"${kind}`;
}

/** What was on top of the element, read from Playwright's "... intercepts pointer events" line. */
function coveringThing(errorText: string): string {
  const line = errorText.split("\n").find((l) => l.includes("intercepts pointer events")) ?? "";
  const tag = line.match(/<(\w+)([^>]*)>/);
  if (!tag) return "another part of the page";
  const attrs = tag[2];
  const label = (attrs.match(/placeholder="([^"]+)"/) ?? attrs.match(/aria-label="([^"]+)"/)
    ?? attrs.match(/title="([^"]+)"/))?.[1];
  if (!label) return "another part of the page";
  const kind = tag[1].toLowerCase() === "input" ? "box" : "element";
  return `the "${label}" ${kind}`;
}

/** "Timeout 10000ms" -> "10 seconds". */
function waitedFor(errorText: string): string {
  const m = errorText.match(/(\d+)ms/);
  if (!m) return "the time allowed";
  const s = Math.round(Number(m[1]) / 1000);
  return s === 1 ? "1 second" : `${s} seconds`;
}

/** One plain sentence saying why this case stopped, or null when there is nothing sure to say. */
export function stopReason(input: StopReasonInput): string | null {
  const status = (input.status || "").toLowerCase();
  const note = input.truncationNote?.trim();

  if (status === "passed") return null;

  if (status === "blocked") {
    return input.blockedBy
      ? `Couldn't finish: ${input.blockedBy}.`
      : "Couldn't finish: the test hit something automation can't get past on its own, like a code sent by email or a \"prove you're not a robot\" check.";
  }

  if (status === "truncated_no_assertion") {
    const where = input.stepCount ? ` after step ${input.stepCount}` : "";
    return `Nothing was checked. The test was cut short${where}, before its check, so it can't confirm this works.`
      + (note ? ` Recorded reason: ${note}` : "");
  }

  if (status === "truncated") {
    const where = input.stepCount ? ` after step ${input.stepCount}` : "";
    return `Only part of the test ran: it was cut short${where}. The steps that ran passed.`
      + (note ? ` Recorded reason: ${note}` : "");
  }

  // Failed. Read Playwright's error, most specific check first.
  const e = input.errorText ?? "";
  if (!e.trim()) return null;
  const thing = thingName(input);

  if (e.includes("intercepts pointer events")) {
    return `${upper(thing)} was on the page, but ${coveringThing(e)} was on top of it, so the click never landed.`;
  }
  if (/strict mode violation/i.test(e)) {
    return `More than one element matched ${thing}, so the test couldn't tell which one to use.`;
  }
  if (/net::ERR_[A-Z_]+/.test(e)) {
    const code = e.match(/net::(ERR_[A-Z_]+)/)![1];
    return `The page could not be loaded (${code}). The site was unreachable or the address was wrong.`;
  }
  if (/element is not (visible|enabled|editable)|element is outside of the viewport|unexpected value "hidden"/i.test(e)) {
    return `${upper(thing)} was on the page but hidden or disabled (for example inside a closed menu), so the test couldn't use it.`;
  }
  if (/<element\(s\) not found>|resolved to 0 elements/i.test(e)) {
    return `${upper(thing)} was never found on the page.`;
  }
  // A value check: Playwright prints what it expected and what the page actually had.
  const expected = e.match(/^\s*Expected[^:\n]*:\s*(.+)$/m)?.[1]?.trim();
  const received = e.match(/^\s*Received[^:\n]*:\s*(.+)$/m)?.[1]?.trim();
  if (expected && received && /expect\(/.test(e)) {
    return `The check failed: expected ${expected}, but the page had ${received}.`;
  }
  if (/Test timeout of \d+ms exceeded/i.test(e)) {
    return "The whole test ran out of time before it finished.";
  }
  if (/Timeout \d+ms exceeded|Timed out \d+ms/i.test(e)) {
    // Playwright prints "locator resolved to <...>" once it has found the element.
    if (!/resolved to\s*</i.test(e)) return `${upper(thing)} was never found on the page.`;
    return `${upper(thing)} was found, but it never became ready within ${waitedFor(e)}.`;
  }
  return null;
}

function upper(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
