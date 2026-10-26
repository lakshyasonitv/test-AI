import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AppModel } from "../schema/appModel.js";
import { localeCacheDimension } from "../browserLaunch.js";
import { dropVolatileIdCss, volatileIdDetectionEnabled } from "../stages/volatileIds.js";
import { cacheSafe } from "../runSecrets.js";

const DIR = path.join("runs", "_cache", "appmodels");
/**
 * URL **and** the locale/timezone it was discovered under.
 *
 * The URL alone was not enough: the same URL served in two languages is two different AppModels,
 * and the element names inside one of them are what every later stage grounds against. The TTL
 * below means a wrong-locale entry heals within 30 minutes, so this is a narrower hole than the
 * walk cache's — but it is two lines to close, and 30 minutes of serving a Korean snapshot to an
 * en-US run is 30 minutes of inexplicable grounding failures.
 *
 * Note this is NOT the LLM cache and `LLM_CACHE_VERSION` does not reach it; `localeCacheDimension`
 * returning "system" when pinning is off keeps an unpinned entry distinct from an en-US one rather
 * than colliding with it.
 */
const keyFor = (url: string) =>
  crypto.createHash("sha1").update(`${url}|||${localeCacheDimension()}`).digest("hex");

/**
 * How long a discovered AppModel stays usable.
 *
 * This cache had NO expiry, so once a URL was discovered it was never discovered again —
 * including after the site under test changed, which is precisely the moment a test platform
 * must notice. A stale model also silently defeats self-healing: the "fresh" snapshot it
 * re-reads would come straight back from this cache.
 *
 * Default 30 minutes, matching llmCache. Override with APPMODEL_CACHE_TTL_MS; 0 disables
 * caching entirely, which is what you want when iterating against a site you're editing.
 */
const TTL_MS = Number(process.env.APPMODEL_CACHE_TTL_MS ?? 30 * 60 * 1000);

/** `ttlMs`: a caller whose key already proves freshness (the org cache's setup fingerprint) keeps
 *  an entry longer. APPMODEL_CACHE_TTL_MS=0 still disables every read. */
export function cacheGet(url: string, ttlMs = TTL_MS): AppModel | null {
  if (TTL_MS <= 0) return null;
  const f = path.join(DIR, keyFor(url) + ".json");
  if (!existsSync(f)) return null;
  try {
    if (Date.now() - statSync(f).mtimeMs > ttlMs) return null;   // stale: rediscover
    const model = AppModel.parse(JSON.parse(readFileSync(f, "utf8")));
    // Discovery upgrade Phase 4: a model cached before an id was proven volatile must not serve that
    // id back as a locator. Every app-model cache hit passes through here.
    if (volatileIdDetectionEnabled()) for (const p of model.pages) dropVolatileIdCss(p.url, p.elements);
    return model;
  } catch {
    return null;
  }
}

export function cacheSet(url: string, model: AppModel): void {
  if (TTL_MS <= 0) return;
  mkdirSync(DIR, { recursive: true });
  // TD-156: a discovered page can PRINT the run's password (SauceDemo's login page does). Never cached as a value.
  writeFileSync(path.join(DIR, keyFor(url) + ".json"), JSON.stringify(cacheSafe(model), null, 2));
}

/** One saved org-connection discovery, as the run screen lists it: the objects its request named. */
export interface OrgDiscoverySave { objects: string[]; savedAt: string }

const ORG_INDEX = () => path.join(DIR, "sf-org-saved.json");
const readOrgIndex = (): Record<string, OrgDiscoverySave[]> => {
  try { return JSON.parse(readFileSync(ORG_INDEX(), "utf8")); } catch { return {}; }
};

/** Note that a discovery of `host` was saved (the cache file itself is keyed by a hash). */
export function noteOrgDiscoverySaved(host: string, objects: string[]): void {
  const index = readOrgIndex();
  const key = objects.join(",");
  const rest = (index[host] ?? []).filter((s) => s.objects.join(",") !== key);
  index[host] = [{ objects, savedAt: new Date().toISOString() }, ...rest].slice(0, 20);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(ORG_INDEX(), JSON.stringify(index, null, 2));
}

/** The saved discoveries of `host` still within `ttlMs`, newest first. Each is reused only while the
 *  org's setup matches the one it was saved under; this list cannot tell that without asking the org. */
export function savedOrgDiscoveries(host: string, ttlMs: number): OrgDiscoverySave[] {
  if (TTL_MS <= 0) return [];
  return (readOrgIndex()[host] ?? []).filter((s) => Date.now() - Date.parse(s.savedAt) <= ttlMs);
}
