import { useEffect, useState, type ReactNode } from "react";
import { badgeClass, statusLabel } from "./api";

/** Loading placeholder with the same spinner classes the classic UI uses. */
export function Loading({ text = "Loading…" }: { text?: string }) {
  return (
    <div className="tree-empty" style={{ padding: "32px 16px", textAlign: "center" }}>
      <span className="ai-busy" role="status">
        <svg className="ai-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
        </svg>
        <span>{text}</span>
      </span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="tree-empty" style={{ padding: "28px 16px", textAlign: "center" }}>{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  return <p className="team-error">{error instanceof Error ? error.message : String(error)}</p>;
}

export function Badge({ status }: { status?: string | null }) {
  return <span className={`case-badge ${badgeClass(status)}`}>{statusLabel(status)}</span>;
}

/** A thumbnail that opens full size in an overlay (the classic UI's screenshot modal). */
export function Shot({ src, label, maxWidth = 220 }: { src: string; label: string; maxWidth?: number }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <img className="cd-shot-img" src={src} alt={label} loading="lazy"
        style={{ maxWidth, marginTop: 8, cursor: "zoom-in" }}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }} />
      {open && (
        <div role="dialog" aria-label={label} onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(10,12,16,.72)", zIndex: 1000,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 24, cursor: "zoom-out" }}>
          <figure style={{ margin: 0, maxWidth: "min(1200px, 95vw)" }}>
            <img src={src} alt={label} style={{ maxWidth: "100%", maxHeight: "85vh", borderRadius: 8 }} />
            <figcaption style={{ color: "#fff", fontSize: 13, marginTop: 8 }}>{label}</figcaption>
          </figure>
        </div>
      )}
    </>
  );
}

/** A small data hook: loads once per `key`, exposes {data, error, loading, reload}. */
export function useLoad<T>(key: string, load: () => Promise<T>) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    load().then((data) => alive && setState({ data, loading: false }))
      .catch((error) => alive && setState({ error, loading: false }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}
