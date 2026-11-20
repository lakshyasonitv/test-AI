import { useEffect, useState } from "react";

/**
 * Hash routing with the classic UI's own route shapes, so a link copied from one UI opens the
 * same page in the other: #/projects, #/projects/<id>, #/suite/<id>, #/case/<id>,
 * #/projects/<pid>/cases/<id>, #/history.
 */
export type Route =
  | { name: "projects" }
  | { name: "project"; projectId: string }
  | { name: "suite"; suiteId: string }
  | { name: "case"; caseId: string; projectId?: string }
  | { name: "history" }
  | { name: "notBuilt"; hash: string };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const parts = raw.split("/").map((p) => decodeURIComponent(p.split("?")[0]));
  const [head, id] = parts;
  if (!head || head === "projects") {
    if (parts[2] === "cases" && parts[3]) return { name: "case", caseId: parts[3], projectId: id };
    return id ? { name: "project", projectId: id } : { name: "projects" };
  }
  if (head === "suite" && id) return { name: "suite", suiteId: id };
  if (head === "case" && id) return { name: "case", caseId: id };
  if (head === "history") return { name: "history" };
  return { name: "notBuilt", hash: "#" + (raw ? "/" + raw : "/") };
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
