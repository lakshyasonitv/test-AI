import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PageModel } from "../schema/appModel.js";
import { llmCacheGet, llmCacheSet, makeCacheKey, credentialFingerprint, llmCacheVersion } from "../kb/llmCache.js";
import { llmCacheDimension } from "../llm/llmContext.js";
import { siteHost } from "../text.js";
import { fingerprintOf, matchingScreenIndex } from "./screens.js";
import { redactCredentials, type Credentials } from "./credentials.js";
import { currentRunId } from "../runContext.js";

/**
 * The persistent screen map (handoff Phase 2, "Application Universe", minimal): every screen a
 * Salesforce run's live captures reached, and which click led from one screen to the next, kept per
 * site so the NEXT run's IR prompt can show them on its first attempt.
 *
 * HINTS, NEVER EVIDENCE (DECISIONS.md D-54). Nothing here grounds a step. The map only feeds the
 * prompt's screens block; grounding still requires a live capture in the current run, so a stale
 * map can cost a retry, never a wrong test. That is also why a 7-day TTL is enough of a freshness
 * rule.
 *
 * NAMES ONLY. A control is stored as role + name (+ disabled). Never css, testId or ids: on Lightning
 * those are generated per session (`#email-145`) and would be wrong on the next run.
 *
 * Stored in the disk cache's "screenmap" namespace (no database, no migration), keyed by site host,
 * organisation dimension and a credential fingerprint, so one tenant or login never sees another's
 * screens. The disk cache never expires, so the TTL is enforced here, on read.
 *
 * General purpose: nothing in this file knows any particular Salesforce site.
 */

export interface ScreenMapControl { role: string; name: string; enabled?: boolean }
export interface ScreenMapEdge { from: string | null; action: { role: string; name: string }; to: string; seen: number }
export interface ScreenMapScreen {
  key: string; url: string; title: string; tab: string; labels: string[];
  controls: ScreenMapControl[]; seen: number; lastSeen: string;
}
export interface ScreenMap { version: 2; site: string; screens: ScreenMapScreen[]; edges: ScreenMapEdge[] }

export const SCREEN_MAP_NS = "screenmap";
export const MAX_MAP_SCREENS = 60;
export const MAX_MAP_EDGES = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `SCREEN_MAP_ENABLED`, default off (CLAUDE.md rule 2). */
export function screenMapEnabled(): boolean {
  return process.env.SCREEN_MAP_ENABLED === "true";
}

/** `SCREEN_MAP_TTL_MS`, default 7 days. A screen not seen for longer is dropped on read. */
export function screenMapTtlMs(): number {
  const n = Number(process.env.SCREEN_MAP_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 7 * DAY_MS;
}

/** One key per site, organisation and login (TD-22: every input dimension). */
export function screenMapKey(baseUrl: string, creds?: Credentials): string {
  return makeCacheKey(siteHost(baseUrl) ?? baseUrl, "salesforce", llmCacheDimension("main"),
    credentialFingerprint(creds), llmCacheVersion());
}

export function emptyScreenMap(baseUrl: string): ScreenMap {
  return { version: 2, site: siteHost(baseUrl) ?? baseUrl, screens: [], edges: [] };
}

/** A captured page as a map screen. `controls` is what the caller already shows the model. */
export function screenFromPage(page: PageModel, controls: ScreenMapControl[], now: Date): ScreenMapScreen {
  const fp = fingerprintOf(page);
  return {
    key: fp.key, url: page.url, title: fp.title, tab: fp.tab, labels: fp.labels,
    controls: controls.map((c) => ({ role: c.role, name: c.name, ...(c.enabled === false ? { enabled: false } : {}) })),
    seen: 1, lastSeen: now.toISOString(),
  };
}

const asFp = (s: ScreenMapScreen) => ({ url: s.url, fp: { key: s.key, title: s.title, tab: s.tab, labels: s.labels } });
const edgeId = (e: Pick<ScreenMapEdge, "from" | "action" | "to">) =>
  JSON.stringify([e.from, e.action.role.toLowerCase(), e.action.name, e.to]);

/**
 * Merge screens and edges into a map. A screen that is the SAME screen as a stored one (the loose
 * rule in screens.ts) replaces it — the fresh capture wins — keeping its `seen` count + 1; edges that
 * pointed at the replaced key follow it. Edges are deduped by (from, action, to). Over the caps, the
 * least recently seen screens and edges go. Pure: returns a new map.
 */
export function mergeIntoMap(
  map: ScreenMap, screens: ScreenMapScreen[], edges: Omit<ScreenMapEdge, "seen">[],
): ScreenMap {
  let stored = map.screens.slice();
  let storedEdges = map.edges.slice();
  const rekey = (from: string, to: string) => {
    if (from === to) return;
    storedEdges = storedEdges.map((e) => ({ ...e, from: e.from === from ? to : e.from, to: e.to === from ? to : e.to }));
  };
  for (const s of screens) {
    const idx = matchingScreenIndex(stored, asFp, asFp(s)); // Phase 3: best match when the flag is on
    if (idx < 0) { stored.push({ ...s }); continue; }
    const old = stored[idx];
    rekey(old.key, s.key);
    stored.splice(idx, 1);
    stored.push({ ...s, seen: old.seen + s.seen });
  }
  // Most recently touched last; on overflow the front (least recently seen) goes.
  for (const e of edges) {
    const i = storedEdges.findIndex((o) => edgeId(o) === edgeId(e));
    const seen = i >= 0 ? storedEdges[i].seen + 1 : 1;
    if (i >= 0) storedEdges.splice(i, 1);
    storedEdges.push({ ...e, action: { ...e.action }, seen });
  }
  stored.sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
  if (stored.length > MAX_MAP_SCREENS) stored = stored.slice(stored.length - MAX_MAP_SCREENS);
  const keys = new Set(stored.map((s) => s.key));
  storedEdges = storedEdges.filter((e) => keys.has(e.to) && (e.from === null || keys.has(e.from)));
  if (storedEdges.length > MAX_MAP_EDGES) storedEdges = storedEdges.slice(storedEdges.length - MAX_MAP_EDGES);
  return { ...map, screens: stored, edges: storedEdges };
}

/** Drop screens older than the TTL (and the edges that touch them). */
export function withinTtl(map: ScreenMap, now: Date, ttlMs = screenMapTtlMs()): ScreenMap {
  const screens = map.screens.filter((s) => now.getTime() - Date.parse(s.lastSeen) <= ttlMs);
  const keys = new Set(screens.map((s) => s.key));
  return { ...map, screens, edges: map.edges.filter((e) => keys.has(e.to) && (e.from === null || keys.has(e.from))) };
}

export function loadScreenMap(baseUrl: string, creds: Credentials | undefined, now: Date): ScreenMap {
  const stored = llmCacheGet<ScreenMap>(screenMapKey(baseUrl, creds), SCREEN_MAP_NS);
  // v2 (2026-10-16): v1 maps hold edges recorded by the "last click before the capture" rule,
  // which named the wrong click; they are dropped rather than trusted, and rebuild on the next run.
  if (!stored || stored.version !== 2) return emptyScreenMap(baseUrl);
  return withinTtl(stored, now);
}

/** Merge this run's findings into the stored map and save it. Redacted first: a control name can
 *  carry what was typed (a login field's value echoed into a heading), and the cache is on disk. */
export function recordIntoScreenMap(
  baseUrl: string, creds: Credentials | undefined, screens: ScreenMapScreen[],
  edges: Omit<ScreenMapEdge, "seen">[], now: Date,
): ScreenMap {
  const merged = mergeIntoMap(loadScreenMap(baseUrl, creds, now), screens, edges);
  llmCacheSet(screenMapKey(baseUrl, creds), redactCredentials(merged, creds), SCREEN_MAP_NS);
  return merged;
}

/** `runs/<id>/09-screen-map.json`: what THIS run's captures added (not the whole stored map). Written
 *  here rather than through orchestrator.ts; a no-op outside a run. Served over HTTP, so redacted. */
export function writeRunScreenMap(baseUrl: string, creds: Credentials | undefined, screens: ScreenMapScreen[],
  edges: Omit<ScreenMapEdge, "seen">[]): void {
  const runId = currentRunId();
  if (!runId) return;
  const dir = path.join("runs", runId);
  mkdirSync(dir, { recursive: true });
  const map = mergeIntoMap(emptyScreenMap(baseUrl), screens, edges);
  writeFileSync(path.join(dir, "09-screen-map.json"), JSON.stringify(redactCredentials(map, creds), null, 2));
}

/**
 * The stored screens in the order a person reaches them: follow the recorded clicks from the entry
 * page (edges whose `from` is null), breadth first; screens no click path reaches come last, oldest
 * first. Pure.
 */
export function orderedScreens(map: ScreenMap): ScreenMapScreen[] {
  const byKey = new Map(map.screens.map((s) => [s.key, s]));
  const out: ScreenMapScreen[] = [];
  const seen = new Set<string>();
  // Edges are recorded only when unambiguous (edgeForCapture), so a chain can start mid-flow: after
  // following everything from the entry page, the OLDEST screen not yet placed starts the next chain.
  const byAge = [...map.screens].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
  let root: string | null = null;
  for (;;) {
    const queue: Array<string | null> = [root];
    if (root !== null) { seen.add(root); out.push(byKey.get(root)!); }
    while (queue.length) {
      const from = queue.shift()!;
      for (const e of map.edges) {
        if (e.from !== from || seen.has(e.to) || !byKey.has(e.to)) continue;
        seen.add(e.to);
        out.push(byKey.get(e.to)!);
        queue.push(e.to);
      }
    }
    const next = byAge.find((s) => !seen.has(s.key));
    if (!next) break;
    root = next.key;
  }
  return out;
}

/**
 * Gap 1: the stored screens as a block for the TEST-CASE prompt, so a case that crosses screens puts
 * each field on the screen that really holds it. "" when there is nothing to show. Names only, in
 * reach order, each with the click that opens it. Capped at `maxScreens`.
 */
export function screensForCases(map: ScreenMap, maxScreens = 12): string {
  const screens = orderedScreens(map).filter((s) => s.controls.length).slice(0, maxScreens);
  if (!screens.length) return "";
  // Several screens of ONE URL (a form's steps) repeat the page around them — a chat button, the
  // header, a list behind a modal. A control on EVERY screen of that URL tells the case writer
  // nothing about which screen holds what, so it is left out (unless nothing would remain).
  const controlId = (c: ScreenMapControl) => `${c.role}\u0000${c.name}`;
  const sharedByUrl = new Map<string, Set<string>>();
  for (const url of new Set(screens.map((s) => s.url))) {
    const group = screens.filter((s) => s.url === url);
    if (group.length < 2) continue;
    const sets = group.map((s) => new Set(s.controls.map(controlId)));
    sharedByUrl.set(url, new Set([...sets[0]].filter((id) => sets.every((set) => set.has(id)))));
  }
  const lines = screens.map((s, i) => {
    let path = s.url;
    try { const u = new URL(s.url); path = u.pathname + u.search; } catch { /* keep the raw url */ }
    const openedBy = Array.from(new Set(map.edges.filter((e) => e.to === s.key)
      .map((e) => `${e.action.role} "${e.action.name}"`))).slice(0, 3);
    const shared = sharedByUrl.get(s.url);
    const own = shared ? s.controls.filter((c) => !shared.has(controlId(c))) : s.controls;
    const controls = (own.length ? own : s.controls)
      .map((c) => `${c.role} "${c.name}"${c.enabled === false ? " (disabled)" : ""}`).join(", ");
    return `- Screen ${i + 1} (${path}${s.title ? `, "${s.title}"` : ""})${openedBy.length ? `, opened by clicking ${openedBy.join(" or ")}` : ""}: ${controls}`;
  });
  return `\nScreens of this application seen by an earlier run (they may have changed), in the order a person reaches them. ` +
    `A multi-screen form on ONE URL appears here as several screens. When a case goes past the first page, use these ` +
    `control names verbatim (quoted), and put each action in the step for the screen that holds that control — never ` +
    `list a later screen's fields under an earlier screen, and include the click that opens each screen:\n${lines.join("\n")}\n`;
}

/**
 * The edge a capture adds, or none. `screenAt` holds this attempt's earlier screens by the step index
 * where each begins (`at`); `prefix` is the steps replayed to reach the new screen `to`, which begins
 * at step `index`. An edge says "clicking X on screen A opens screen B", so it is recorded only when
 * that is unambiguous (run 2026-10-16T05-34-49 stored two wrong ones under the old "last click" rule):
 *  - A is the latest earlier screen (null = the entry page);
 *  - exactly ONE click/press happened since A began — after "View Project" then "Select for EOI",
 *    which of them changed the screen is unknown;
 *  - A is not B — a click that re-renders the screen it is on ("Self Use") opens nothing.
 * Pure.
 */
export function edgeForCapture(
  screenAt: { at: number; key: string }[], prefix: Array<{ action: string; target?: { role?: string; name?: string } }>,
  index: number, to: string,
): Omit<ScreenMapEdge, "seen"> | undefined {
  const prev = screenAt.filter((s) => s.at < index).sort((a, b) => a.at - b.at).at(-1);
  const from = prev?.key ?? null;
  if (from === to) return undefined;
  const clicks = prefix.slice(prev?.at ?? 0).filter((s) => (s.action === "click" || s.action === "press") && s.target?.name);
  if (clicks.length !== 1) return undefined;
  return { from, action: { role: clicks[0].target!.role ?? "", name: clicks[0].target!.name! }, to };
}

/**
 * TD-142: the click(s) that lead from screen `fromKey` to the nearest screen holding a control named
 * `name`, as a sentence for a rejection message — or undefined when the map has no such route.
 *
 * Run 2026-10-16T09-07-56: the case put "Preferred Project" on form screen 2. Grounding said "not on
 * this screen; a step that opens the screen holding it is probably missing", and the retry still left
 * the "Next" out. The map knew: screen 2 --Next--> screen 3, which holds "Preferred Project". Breadth-
 * first over the stored edges, at most 4 clicks. Exact names only (case and spacing ignored). Pure.
 */
export function routeToControl(
  map: { screens: Pick<ScreenMapScreen, "key" | "controls">[]; edges: Omit<ScreenMapEdge, "seen">[] }, fromKey: string, name: string,
): string | undefined {
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const want = n(name);
  if (!want) return undefined;
  const holds = new Set(map.screens.filter((s) => s.key !== fromKey && s.controls.some((c) => n(c.name) === want)).map((s) => s.key));
  if (!holds.size) return undefined;
  const queue: { key: string; path: ScreenMapEdge["action"][] }[] = [{ key: fromKey, path: [] }];
  const seen = new Set([fromKey]);
  while (queue.length) {
    const { key, path } = queue.shift()!;
    if (path.length >= 4) continue;
    for (const e of map.edges) {
      if (e.from !== key || seen.has(e.to)) continue;
      const next = [...path, e.action];
      if (holds.has(e.to)) {
        return `Earlier runs on this site found it on a LATER screen, opened from this one by clicking ` +
          `${next.map((a) => `${a.role} "${a.name}"`).join(", then ")}. Put that click BEFORE this step, and ` +
          `this step (and the others for that screen) after it, even where the test case lists them earlier.`;
      }
      seen.add(e.to);
      queue.push({ key: e.to, path: next });
    }
  }
  return undefined;
}
