import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent, type ClipboardEvent } from "react";
import { fetchFrame, sendInput, type RecInput, type RecState } from "../recorderApi";

/**
 * The remote browser's screen. It polls for the newest frame (only when one is newer) and turns
 * clicks, keys, paste and wheel into input events sent in small batches, one request at a time.
 * Coordinates go as fractions of the picture, so the shown size never matters.
 */
export function LiveScreen({ id, checkMode, onState }: { id: string; checkMode: boolean; onState: (s: RecState) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const queue = useRef<RecInput[]>([]);
  const sending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheel = useRef(0);

  // Frames: keep asking for anything newer than the last one shown.
  useEffect(() => {
    let alive = true;
    let seq = -1;
    let last: string | null = null;
    const loop = async () => {
      while (alive) {
        const f = await fetchFrame(id, seq).catch(() => null);
        if (!alive) { if (f) URL.revokeObjectURL(f.url); break; }
        if (f) {
          seq = f.seq;
          setSrc(f.url);
          if (last) URL.revokeObjectURL(last);
          last = f.url;
        }
        await new Promise((r) => setTimeout(r, f ? 120 : 300));
      }
    };
    void loop();
    return () => { alive = false; if (last) URL.revokeObjectURL(last); };
  }, [id]);

  const flush = async () => {
    timer.current = null;
    if (sending.current || queue.current.length === 0) return;
    sending.current = true;
    const batch = queue.current.splice(0);
    try { onState(await sendInput(id, batch)); } catch { /* the next state poll shows the problem */ }
    sending.current = false;
    if (queue.current.length) void flush();
  };
  const push = (e: RecInput, now = false) => {
    // Consecutive typing goes as one text event.
    const lastEv = queue.current[queue.current.length - 1];
    if (e.type === "text" && lastEv?.type === "text") lastEv.text += e.text;
    else queue.current.push(e);
    if (now) { if (timer.current) clearTimeout(timer.current); void flush(); }
    else if (!timer.current) timer.current = setTimeout(() => void flush(), 80);
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const img = e.currentTarget.querySelector("img");
    if (!img) return;
    const r = img.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    keys.current?.focus();
    push({ type: "click", x, y }, true);
  };

  // Text arrives through a hidden box's `input` event, not keydown: that also covers IME
  // composition (Hindi and other input methods), autocorrect, dictation and synthetic typing.
  // keydown only sends the named keys and shortcuts.
  const keys = useRef<HTMLTextAreaElement>(null);
  const onInput = () => {
    const box = keys.current;
    if (!box || composing.current) return;
    if (box.value) push({ type: "text", text: box.value.slice(0, 2000) });
    box.value = "";
  };
  const composing = useRef(false);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key) || composing.current) return;
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key.length === 1 && !mod) return; // printable: let it reach the box, onInput sends it
    if (mod && e.key.toLowerCase() === "v") return; // paste: the box receives it, onPaste sends it
    e.preventDefault();
    const parts = [e.ctrlKey && "Control", e.metaKey && "Meta", e.altKey && "Alt", e.shiftKey && e.key.length > 1 && "Shift"].filter(Boolean);
    const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const combo = [...parts, key].join("+");
    if (!/^[A-Za-z0-9+]{1,40}$/.test(combo)) return; // the server accepts named keys only
    push({ type: "key", key: combo }, e.key === "Enter");
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (text) push({ type: "text", text: text.slice(0, 2000) });
  };

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    wheel.current += e.deltaY;
    if (Math.abs(wheel.current) < 40) return;
    push({ type: "scroll", dy: Math.max(-2000, Math.min(2000, Math.round(wheel.current))) });
    wheel.current = 0;
  };

  return (
    <div className={`rx-rec-screen${focused ? " rx-rec-focus" : ""}${checkMode ? " rx-rec-check" : ""}`}
      onClick={onClick} onWheel={onWheel}>
      <textarea ref={keys} className="rx-rec-keys" aria-label="Live browser. Click the picture to interact; type while it is focused."
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onKeyDown={onKeyDown} onInput={onInput} onPaste={onPaste}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; onInput(); }}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
      {src ? <img src={src} alt="The page in the recording browser" draggable={false} /> : <div className="rx-rec-wait">Opening the browser…</div>}
    </div>
  );
}
