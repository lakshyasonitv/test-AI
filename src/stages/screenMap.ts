import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PageModel } from "../schema/appModel.js";
import { llmCacheGet, llmCacheSet, makeCacheKey, credentialFingerprint, llmCacheVersion } from "../kb/llmCache.js";
import { llmCacheDimension } from "../llm/llmContext.js";
import { siteHost } from "../text.js";
import { fingerprintOf, sameScreen } from "./screens.js";
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
export interface ScreenMap { version: 1; site: string; screens: ScreenMapScreen[]; edges: ScreenMapEdge[] }

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
  return { version: 1, site: siteHost(baseUrl) ?? baseUrl, screens: [], edges: [] };
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
    const idx = stored.findIndex((o) => sameScreen(asFp(o), asFp(s)));
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
  if (!stored || stored.version !== 1) return emptyScreenMap(baseUrl);
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
