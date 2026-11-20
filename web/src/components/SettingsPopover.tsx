import { useEffect, useRef, useState } from "react";
import { toggleRunOption, useRunOptions } from "../lib/runOptions";
import { acctFetch } from "../lib/session";

const CLEAR_IDLE = "Forget saved page snapshots used when editing steps";

/** The three "Run behaviour" rows, shared by the page and the popover. */
export function RunBehaviourRows() {
  const value = useRunOptions();
  const [note, setNote] = useState(CLEAR_IDLE);
  const [clearing, setClearing] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  const clearCache = async () => {
    setClearing(true);
    setNote("Clearing…");
    try {
      const res = await acctFetch("/api/cache/walks/clear", { method: "POST" });
      const body = await res.json().catch(() => null);
      setNote(res.ok
        ? (body?.message ?? "Cleared.")
        : (res.status === 403 ? "Only an admin can clear the cache." : (body?.error ?? "Could not clear the cache.")));
    } catch {
      setNote("Could not reach the server.");
    } finally {
      setClearing(false);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setNote(CLEAR_IDLE), 6000);
    }
  };

  return (
    <>
      <button type="button" className="settings-row" id="gateToggle" aria-pressed={value("gateReview")}
        onClick={() => toggleRunOption("gateReview")}>
        <span className="switch"><span className="switch-knob" /></span>
        <span className="settings-row-text">
          <b>Review cases before running</b>
          <span>Pause to approve the AI&rsquo;s test cases</span>
        </span>
      </button>
      <button type="button" className="settings-row" id="healToggle" aria-pressed={value("selfHeal")}
        onClick={() => toggleRunOption("selfHeal")}>
        <span className="switch"><span className="switch-knob" /></span>
        <span className="settings-row-text">
          <b>Self-heal broken selectors</b>
          <span>Retry once after re-reading the page</span>
        </span>
      </button>
      <button type="button" className="settings-row" id="clearWalkCacheBtn" disabled={clearing} onClick={clearCache}>
        <span className="settings-row-text">
          <b>Clear verification cache</b>
          <span id="clearWalkCacheNote">{note}</span>
        </span>
      </button>
    </>
  );
}

/**
 * The topbar Settings button and its popover (app.js #settingsBtn / #settingsPop): toggles open,
 * closes on a click outside. The same three rows as the page.
 */
export function SettingsPopover() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  return (
    <span ref={wrap} style={{ position: "relative", display: "inline-block" }}>
      <button type="button" id="settingsBtn" className="topbar-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Settings</button>
      <div id="settingsPop" className={`settings-pop${open ? "" : " hidden"}`}>
        <h2>Run behaviour</h2>
        <RunBehaviourRows />
      </div>
    </span>
  );
}
