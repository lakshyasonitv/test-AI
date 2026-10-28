import crypto from "node:crypto";
import { llmCacheGet, llmCacheSet, makeCacheKey, credentialFingerprint, llmCacheVersion } from "../kb/llmCache.js";
import { llmCacheDimension } from "../llm/llmContext.js";
import { localeCacheDimension } from "../browserLaunch.js";
import { pageKey, siteHost } from "../text.js";
import { currentRunId } from "../runContext.js";
import { runCredentialsFor } from "../runSecrets.js";

/**
 * Discovery upgrade Phase 4 (`VOLATILE_ID_DETECTION_ENABLED`, default off; README; DECISIONS D-59).
 *
 * An element id is only a good locator if it is the same on the next visit. A naming PATTERN cannot
 * tell: Lightning's `input-145` is a new number every session, but a developer's `unit-102` is
 * stable, and the Salesforce rule (D-55) drops both (TD-133). Evidence can tell: when the SAME element
 * (role + accessible name on the same screen) is seen on two walks,
 * - with a DIFFERENT id → that id is volatile: never offered as a locator again for that element;
 * - with the SAME id → it is stable: kept even if it looks generated (fixes TD-133);
 * - seen only once → no evidence yet: today's pattern rule applies unchanged.
 *
 * What is stored, per site (with the screen map's cache-key dimensions: org, credential, locale,
 * cache version — TD-22): role, name, screen (page key + dialog name), stable yes/no/unknown, and a
 * 12-hex SHA-1 of the last id seen. The hash exists only so the next walk can say "same / different";
 * the id itself, css, typed values and credentials are never stored.
 *
 * Applied in Node between the in-page walk and the Playwright verification, so the in-browser code
 * (TD-40) is untouched and every candidate it keeps is still verified the same way.
 */
export function volatileIdDetectionEnabled(): boolean {
  return process.env.VOLATILE_ID_DETECTION_ENABLED === "true";
}

export const VOLATILE_IDS_NS = "volatileids";
const MAX_ENTRIES = 2000;

export type IdStability = "yes" | "no" | "unknown";
export interface IdEvidence {
  screen: string; role: string; name: string;
  idHash: string; stable: IdStability; seen: number; lastSeen: string;
}
interface IdEvidenceStore { version: 1; entries: IdEvidence[] }

/** The walker's element shape, as far as this module needs it. */
export interface WalkedForIds {
  role: string; name: string; id: string; css: string; candidates: string[];
  inShadow: boolean; dialogName: string | null;
}

const hashId = (id: string) => crypto.createHash("sha1").update(id).digest("hex").slice(0, 12);
const entryKey = (e: Pick<IdEvidence, "screen" | "role" | "name">) => `${e.screen}\u0000${e.role}\u0000${e.name}`;
/** Lightning-shaped generated ids — the D-55 pattern, mirrored from the walker. */
export const looksGenerated = (id: string) => /-\d+$/.test(id) || /^\w+-\d+-\d+$/.test(id);

export function volatileIdsKey(siteUrl: string): string {
  const runId = currentRunId();
  const creds = runId ? runCredentialsFor(runId) : undefined;
  return makeCacheKey(siteHost(siteUrl) ?? siteUrl, "volatile-ids", llmCacheDimension("main"),
    credentialFingerprint(creds), localeCacheDimension(), llmCacheVersion());
}

/** The two selector spellings the walker uses for an element's own id. */
function idSelectors(id: string): string[] {
  const quoted = "[id=\"" + id.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\a ") + "\"]";
  return [`#${id}`, quoted];
}
const lastSegment = (cand: string) => { const i = cand.lastIndexOf(" >> "); return i < 0 ? cand : cand.slice(i + 4); };
const chainOf = (cand: string) => { const i = cand.lastIndexOf(" >> "); return i < 0 ? "" : cand.slice(0, i + 4); };
/** The walker's positional fallback (`body > div:nth-of-type(2) > button`, `:scope > …`, `#anchor > …`):
 *  the only candidate shape with a child combinator. Role / label / attribute candidates never have one. */
const isPositional = (seg: string) => !seg.startsWith("role=") && (seg.includes(" > ") || /^(body|:scope)\b/.test(seg));
/** True when `id` needs no CSS escaping, so `#id` is valid (the walker's own test, without CSS.escape). */
const plainIdent = (id: string) => /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(id);

/**
 * For a page model served from a CACHE (the walk cache never expires): drop an element's `css` when
 * it is that element's own id selector and the evidence says the id is volatile. There are no
 * candidates left to re-pick from, so the element keeps its role + name and grounding falls back to
 * them. Returns the number of css values dropped. Mutates `elements`.
 */
export function dropVolatileIdCss(
  pageUrl: string,
  elements: Array<{ role: string; name: string; css?: string; containerRole?: string; containerName?: string }>,
): number {
  const stored = llmCacheGet<IdEvidenceStore>(volatileIdsKey(pageUrl), VOLATILE_IDS_NS);
  if (stored?.version !== 1) return 0;
  const volatile = new Set(stored.entries.filter((e) => e.stable === "no").map(entryKey));
  let dropped = 0;
  for (const el of elements) {
    if (!el.css) continue;
    const seg = lastSegment(el.css);
    if (!seg.startsWith("#") && !seg.startsWith("[id=")) continue;
    const dialog = el.containerRole === "dialog" ? (el.containerName ?? "") : "";
    const screen = `${pageKey(pageUrl)}|${dialog.trim().toLowerCase()}`;
    if (volatile.has(entryKey({ screen, role: el.role, name: el.name }))) { delete el.css; dropped++; }
  }
  return dropped;
}

export interface IdEvidenceResult { volatileDropped: number; stableKept: number; firstSightings: number; ambiguous: number }

/**
 * Update the evidence with one walked document and adjust each element's candidates in place.
 * `salesforce`: whether the walker applied the D-55 generated-id rule (so a stable id must be put
 * back). Pure apart from the cache read/write; returns counts for the log line.
 */
export function applyIdEvidence(
  pageUrl: string, items: WalkedForIds[], salesforce: boolean, now = new Date(),
): IdEvidenceResult {
  const key = volatileIdsKey(pageUrl);
  const stored = llmCacheGet<IdEvidenceStore>(key, VOLATILE_IDS_NS);
  const entries = new Map<string, IdEvidence>();
  if (stored?.version === 1) for (const e of stored.entries) entries.set(entryKey(e), e);
  const result: IdEvidenceResult = { volatileDropped: 0, stableKept: 0, firstSightings: 0, ambiguous: 0 };

  // An element is identified by role + name on its screen. Two elements sharing that (one "Select"
  // per unit) cannot be told apart across walks, so they record nothing and keep today's rule.
  const screenOf = (it: WalkedForIds) => `${pageKey(pageUrl)}|${(it.dialogName ?? "").trim().toLowerCase()}`;
  const groups = new Map<string, WalkedForIds[]>();
  for (const it of items) {
    if (!it.id || !it.role || !it.name) continue;
    const k = entryKey({ screen: screenOf(it), role: it.role, name: it.name });
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }

  for (const [k, group] of groups) {
    if (group.length > 1) { result.ambiguous += group.length; continue; }
    const it = group[0];
    const h = hashId(it.id);
    const prev = entries.get(k);
    let stable: IdStability;
    if (!prev) { stable = "unknown"; result.firstSightings++; }
    else if (prev.stable === "no" || prev.idHash !== h) stable = "no"; // once volatile, always volatile
    else stable = "yes";
    entries.set(k, {
      screen: screenOf(it), role: it.role, name: it.name, idHash: h, stable,
      seen: (prev?.seen ?? 0) + 1, lastSeen: now.toISOString(),
    });

    const own = new Set(idSelectors(it.id));
    if (stable === "no") {
      const before = it.candidates.length;
      it.candidates = it.candidates.filter((c) => !own.has(lastSegment(c)));
      if (it.candidates.length !== before) result.volatileDropped++;
      if (own.has(lastSegment(it.css))) it.css = it.candidates[0] ?? "";
    } else if (stable === "yes" && salesforce && looksGenerated(it.id)) {
      // TD-133: the walker dropped this id by pattern; two walks say it is stable. It comes back only
      // as a FALLBACK: after every role / label candidate (D-55), just before the positional path,
      // so Playwright's first-unique pick uses it only when no role or label locator is unique.
      // (First place made it win everywhere: 0 → 12 generated-id locators on the Salesforce site,
      // and Lightning numbers by render order, so a different render can still shift it.)
      const prefix = it.inShadow && it.candidates.length ? chainOf(it.candidates[0]) : "";
      if (!it.inShadow || prefix) {
        const cand = prefix + (plainIdent(it.id) ? `#${it.id}` : idSelectors(it.id)[1]);
        if (!it.candidates.includes(cand)) {
          const at = it.candidates.findIndex((c) => isPositional(lastSegment(c)));
          if (at < 0) it.candidates.push(cand); else it.candidates.splice(at, 0, cand);
          result.stableKept++;
        }
      }
    }
  }

  const all = [...entries.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
  llmCacheSet(key, { version: 1, entries: all.slice(Math.max(0, all.length - MAX_ENTRIES)) }, VOLATILE_IDS_NS);
  return result;
}
