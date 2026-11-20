import { useEffect, useState } from "react";

/**
 * Hash routing with the classic UI's own route shapes, so a link copied from one UI opens the
 * same page in the other: #/ (New test), #/dashboard, #/run/<id>, #/projects, #/projects/<id>,
 * #/suite/<id>, #/case/<id>, #/projects/<pid>/cases/<id>, #/compare/<caseId>?from=&to=,
 * #/history, #/settings, #/team, #/admin.
 */
export type Route =
  | { name: "newtest" }
  | { name: "dashboard" }
  | { name: "run"; runId: string }
  | { name: "projects" }
  | { name: "project"; projectId: string }
  | { name: "suite"; suiteId: string }
  | { name: "case"; caseId: string; projectId?: string }
  | { name: "compare"; caseId: string; from?: number; to?: number }
  | { name: "history" }
  | { name: "settings" }
  | { name: "team" }
  | { name: "admin" }
  | { name: "notBuilt"; hash: string };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/").map((p) => decodeURIComponent(p));
  const params = new URLSearchParams(query);
  const num = (k: string) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : undefined);
  const [head, id] = parts;
  if (!head) return { name: "newtest" };
  if (head === "dashboard") return { name: "dashboard" };
  if (head === "run" && id) return { name: "run", runId: id };
  if (head === "projects") {
    if (parts[2] === "cases" && parts[3]) return { name: "case", caseId: parts[3], projectId: id };
    return id ? { name: "project", projectId: id } : { name: "projects" };
  }
  if (head === "suite" && id) return { name: "suite", suiteId: id };
  if (head === "case" && id) return { name: "case", caseId: id };
  if (head === "compare" && id) return { name: "compare", caseId: id, from: num("from"), to: num("to") };
  if (head === "history") return { name: "history" };
  if (head === "settings") return { name: "settings" };
  if (head === "team") return { name: "team" };
  if (head === "admin") return { name: "admin" };
  return { name: "notBuilt", hash: "#/" + raw };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => { setRoute(parseRoute(location.hash)); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (hash: string): void => { location.hash = hash; };
