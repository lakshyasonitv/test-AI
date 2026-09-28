import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AppModel } from "../schema/appModel.js";
import { localeCacheDimension } from "../browserLaunch.js";

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

export function cacheGet(url: string): AppModel | null {
  if (TTL_MS <= 0) return null;
  const f = path.join(DIR, keyFor(url) + ".json");
  if (!existsSync(f)) return null;
  try {
    if (Date.now() - statSync(f).mtimeMs > TTL_MS) return null;   // stale: rediscover
    return AppModel.parse(JSON.parse(readFileSync(f, "utf8")));
  } catch {
    return null;
  }
}

export function cacheSet(url: string, model: AppModel): void {
  if (TTL_MS <= 0) return;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, keyFor(url) + ".json"), JSON.stringify(model, null, 2));
}
