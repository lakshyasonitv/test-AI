import { isIP } from "node:net";
import type { Step, Target } from "../schema/ir.js";
import { formatIrStep, nextStepId } from "./stepText.js";

/**
 * The recorder's pure half (docs/phases/PLAN_RECORD_ONCE.md, option C): what a person did in the
 * live browser, turned into IR steps. No browser, no LLM (DECISIONS.md D-06) — the browser half is
 * src/server/recorderSessions.ts, which resolves every target against the LIVE page with
 * Playwright's own locators before it reaches here, so a target in these steps is one that was
 * observed, not generated.
 */

/** One thing the person did, already resolved to a target by the session. */
export type RecordedAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target: Target }
  | { kind: "fill"; target: Target; value: string; secret: boolean }
  | { kind: "check"; target: Target }
  | { kind: "select"; target: Target; value: string }
  | { kind: "press"; key: string }
  | { kind: "assert_visible"; target: Target }
  | { kind: "assert_text"; text: string }
  | { kind: "assert_url"; value: string };

/** The `${env:...}` references a saved case uses for a login (CLAUDE.md rule 5). */
export const PASSWORD_REF = "${env:TEST_PASSWORD}";
export const USERNAME_REF = "${env:TEST_USERNAME}";

const sameTarget = (a?: Target, b?: Target): boolean =>
  JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/**
 * Append one action to the recorded steps, merging where a person's single intent took several
 * events:
 *  - typing into the same box again replaces the earlier fill (one `fill` per box, last value wins);
 *  - the click that focused a box is dropped when the very next step types into that box;
 *  - navigating to the address the page is already on adds nothing.
 * Returns a NEW array; the input is not mutated.
 */
export function appendAction(steps: Step[], action: RecordedAction): Step[] {
  const out = [...steps];
  const last = out[out.length - 1];
  const id = nextStepId(out);

  switch (action.kind) {
    case "navigate": {
      if (last?.action === "navigate" && last.target?.url === action.url) return out;
      out.push({ id, action: "navigate", target: { url: action.url } });
      return out;
    }
    case "click":
      out.push({ id, action: "click", target: action.target });
      return out;
    case "fill": {
      const value = action.secret ? PASSWORD_REF : action.value;
      if (last?.action === "fill" && sameTarget(last.target, action.target)) {
        out[out.length - 1] = { ...last, value };
        return out;
      }
      if (last?.action === "click" && sameTarget(last.target, action.target)) out.pop();
      out.push({ id: nextStepId(out), action: "fill", target: action.target, value });
      return out;
    }
    case "check":
      out.push({ id, action: "check", target: action.target });
      return out;
    case "select": {
      if (last?.action === "select" && sameTarget(last.target, action.target)) {
        out[out.length - 1] = { ...last, value: action.value };
        return out;
      }
      out.push({ id, action: "select", target: action.target, value: action.value });
      return out;
    }
    case "press":
      out.push({ id, action: "press", value: action.key });
      return out;
    case "assert_visible":
      out.push({ id, action: "assert", assertion: "visible", target: action.target });
      return out;
    case "assert_text":
      out.push({ id, action: "assert", assertion: "text_contains", value: action.text });
      return out;
    case "assert_url":
      out.push({ id, action: "assert", assertion: "url_contains", value: action.value });
      return out;
  }
}

/**
 * Before saving: the box typed into straight before a password (the username or email) becomes
 * `${env:TEST_USERNAME}`, so neither half of a login is stored as a literal (rule 5). Only a fill
 * immediately before the password fill, with nothing but clicks between them, counts.
 */
export function withCredentialRefs(steps: Step[]): Step[] {
  const out = steps.map((s) => ({ ...s }));
  for (let i = 0; i < out.length; i++) {
    if (out[i].action !== "fill" || out[i].value !== PASSWORD_REF) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (out[j].action === "click") continue;
      if (out[j].action === "fill" && out[j].value !== PASSWORD_REF) out[j].value = USERNAME_REF;
      break;
    }
  }
  return out;
}

/** The steps as the step editor's sentences (the same `formatIrStep` the editor round-trips). */
export function stepsAsText(steps: Step[]): { id: string; text: string }[] {
  return steps.map((s) => ({ id: s.id, text: formatIrStep(s) }));
}

/** A short title for a recording that was not given one: "Recorded flow on example.com". */
export function defaultRecordingTitle(steps: Step[]): string {
  const nav = steps.find((s) => s.action === "navigate")?.target?.url;
  try { if (nav) return `Recorded flow on ${new URL(nav).hostname}`; } catch { /* fall through */ }
  return "Recorded flow";
}

// ---------------------------------------------------------------------------------------------
// SSRF guard: the server's own Chromium must not be steered at the server's own network.
// ---------------------------------------------------------------------------------------------

/**
 * True for an address a recording browser must never reach: loopback, private ranges, link-local
 * (including the cloud metadata address 169.254.169.254), carrier-grade NAT, multicast and the
 * unspecified address, in IPv4 and IPv6 (including IPv4-mapped IPv6).
 */
export function isBlockedAddress(address: string): boolean {
  let ip = address.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) ip = mapped[1];
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  if (kind === 6) {
    return ip === "::" || ip === "::1"
      || ip.startsWith("fc") || ip.startsWith("fd")
      || ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")
      || ip.startsWith("ff");
  }
  return false;
}

/** Only these schemes may load in a recording browser. */
export function isAllowedScheme(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:" || p === "data:" || p === "blob:" || p === "about:";
  } catch { return false; }
}

/** A typed address normalised the way the New test box does: no scheme means https. */
export function normaliseStartUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const v = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch { return null; }
}
