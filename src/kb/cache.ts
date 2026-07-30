import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AppModel } from "../schema/appModel.js";

const DIR = path.join("runs", "_cache", "appmodels");
const keyFor = (url: string) => crypto.createHash("sha1").update(url).digest("hex");

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
