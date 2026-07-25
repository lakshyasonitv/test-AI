import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AppModel } from "../schema/appModel.js";

const DIR = path.join("runs", "_cache", "appmodels");
const keyFor = (url: string) => crypto.createHash("sha1").update(url).digest("hex");

export function cacheGet(url: string): AppModel | null {
  const f = path.join(DIR, keyFor(url) + ".json");
  if (!existsSync(f)) return null;
  try { return AppModel.parse(JSON.parse(readFileSync(f, "utf8"))); }
  catch { return null; }
}

export function cacheSet(url: string, model: AppModel): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, keyFor(url) + ".json"), JSON.stringify(model, null, 2));
}
