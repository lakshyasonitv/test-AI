import { useEffect } from "react";
import { parseRoute } from "../../../lib/router";

export interface CredRequest { jobId: string; data: { url?: string; caseEdit?: boolean } | undefined; postUrl: string }

/**
 * The classic applyRoute guard: leaving this case with unsaved step edits asks first, and saying
 * no puts the previous hash back. Listens in the CAPTURE phase so it runs before the app router's
 * own hashchange listener and can stop it — otherwise the page would unmount (losing the edits)
 * before the answer. Also the browser's beforeunload guard for reload / close / external links.
 * `bypass` lets Duplicate and Delete leave without asking, as app.js drops its editor first.
 */
export function useLeaveGuard(caseId: string, dirty: () => boolean, bypass: { current: boolean }) {
  useEffect(() => {
    let last = location.hash;
    let restoring = false;
    const staysOnCase = (hash: string) => { const r = parseRoute(hash); return r.name === "case" && r.caseId === caseId; };
    const onHash = (e: HashChangeEvent) => {
      if (restoring) { restoring = false; last = location.hash; return; }
      if (!bypass.current && dirty() && !staysOnCase(location.hash)) {
        if (!confirm("You have unsaved step changes. Leave and discard them?")) {
          e.stopImmediatePropagation();
          if (location.hash !== last) { restoring = true; location.hash = last; }
          return;
        }
      }
      last = location.hash;
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (bypass.current || !dirty()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("hashchange", onHash, true);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("hashchange", onHash, true);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [caseId, dirty, bypass]);
}
