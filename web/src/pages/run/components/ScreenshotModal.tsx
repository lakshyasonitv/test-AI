import { useEffect, useRef } from "react";

export function ScreenshotModal({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previously = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "Tab") { e.preventDefault(); closeRef.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Focus back to whatever opened the modal, so a keyboard user isn't dropped at the top.
      if (previously && typeof previously.focus === "function") previously.focus();
    };
  }, [onClose]);
  return (
    <div className="screenshot-modal" role="dialog" aria-modal="true" aria-label="Screenshot, full size"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <span className="screenshot-modal-label">{label}</span>
      <button ref={closeRef} className="screenshot-modal-close" type="button" aria-label="Close" onClick={onClose}>Close</button>
      <img className="screenshot-modal-img" src={src} alt={label || "Screenshot, full size"} />
    </div>
  );
}

// ------------------------------------------------------------------ save to library
