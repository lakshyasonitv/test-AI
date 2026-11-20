import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chromium, type Browser, type BrowserContext, type CDPSession, type ElementHandle, type Locator, type Page } from "playwright";
import { browserContextOptions, chromiumLaunchOptions } from "../browserLaunch.js";
import type { Step, Target } from "../schema/ir.js";
import { appendAction, isAllowedScheme, isBlockedAddress, stepsAsText, type RecordedAction } from "../stages/recorder.js";
import { AccessError } from "./authz.js";

/**
 * Live recording sessions (docs/phases/PLAN_RECORD_ONCE.md, option C; RECORDER_ENABLED).
 *
 * One Chromium per session, on this server. Its screen streams out as CDP screencast frames (only
 * the latest is kept), and the person's input comes back through `page.mouse` / `page.keyboard`.
 *
 * EVERY ACTION GOES THROUGH HERE, so the target is resolved BEFORE the action runs: the element
 * under the click (or the focused box for typing) is named with Playwright's own locators —
 * Chromium's accessibility tree for role + name, then a uniqueness check — while it still exists.
 * No script is injected into the site to watch for clicks, so the site's CSP is irrelevant.
 *
 * Secrets: typed text goes from the request straight to `page.keyboard` and is never logged or
 * stored. A password box is recorded as `${env:TEST_PASSWORD}` and its value is never read
 * (CLAUDE.md rule 5).
 */

export const VIEWPORT = { width: 1280, height: 720 } as const;
const IDLE_MS = Number(process.env.RECORDER_IDLE_MINUTES ?? 10) * 60_000;
const HARD_MS = 30 * 60_000;
const maxSessions = () => Math.max(1, Number(process.env.RECORDER_MAX_SESSIONS ?? 2) || 2);
const allowPrivateNetwork = () => process.env.RECORDER_ALLOW_PRIVATE_NETWORK === "true";

export type RecorderInput =
  | { type: "click"; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dx?: number; dy: number }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "select"; value: string };

interface Typing { handle: ElementHandle; target: Target; secret: boolean; value: string | null }

interface Session {
  id: string;
  userId: string;
  orgId: string;
  projectId: string;
  startUrl: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession | null;
  frame: Buffer | null;
  frameSeq: number;
  steps: Step[];
  checkMode: boolean;
  typing: Typing | null;
  pendingSelect: { handle: ElementHandle; target: Target | null; options: { value: string; label: string }[] } | null;
  notices: string[];
  createdAt: number;
  lastActive: number;
  busy: Promise<unknown>;
  closed: boolean;
}

const sessions = new Map<string, Session>();

// ---------------------------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------------------------

export function activeRecordingCount(): number { return sessions.size; }

export async function startRecording(opts: { userId: string; orgId: string; projectId: string; url: string }): Promise<string> {
  sweep();
  if (sessions.size >= maxSessions()) {
    throw new AccessError(429, `${sessions.size} recording(s) already running on this server — finish one and try again.`);
  }
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const context = await browser.newContext({
      ...browserContextOptions(),
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    await guardNetwork(context);
    const page = await context.newPage();
    const id = randomBytes(16).toString("hex");
    const s: Session = {
      id, userId: opts.userId, orgId: opts.orgId, projectId: opts.projectId, startUrl: opts.url,
      browser, context, page, cdp: null, frame: null, frameSeq: 0,
      steps: [], checkMode: false, typing: null, pendingSelect: null, notices: [],
      createdAt: Date.now(), lastActive: Date.now(), busy: Promise.resolve(), closed: false,
    };
    sessions.set(id, s);
    wirePage(s, page);
    context.on("page", (p) => { void adoptPopup(s, p); });
    await startScreencast(s);
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((err) => {
      s.notices.push(`Could not open the page: ${(err as Error).message.split("\n")[0]}`);
    });
    s.steps = appendAction(s.steps, { kind: "navigate", url: page.url() !== "about:blank" ? page.url() : opts.url });
    return id;
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

/** The session, only for the user and organisation that started it; anyone else gets a 404. */
export function getRecording(id: string, userId: string, orgId: string): Session {
  const s = sessions.get(id);
  if (!s || s.closed || s.userId !== userId || s.orgId !== orgId) throw new AccessError(404, "no such recording");
  s.lastActive = Date.now();
  return s;
}

export async function closeRecording(s: Session): Promise<void> {
  if (s.closed) return;
  s.closed = true;
  sessions.delete(s.id);
  s.typing = null;
  await s.browser.close().catch(() => {});
}

function sweep(): void {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastActive > IDLE_MS || now - s.createdAt > HARD_MS) void closeRecording(s);
  }
}
setInterval(sweep, 30_000).unref();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => { for (const s of sessions.values()) void s.browser.close().catch(() => {}); });
}

/** Serialise everything that touches one session's page, so two requests never interleave. */
function serial<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const next = s.busy.then(fn, fn);
  s.busy = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------------------------
// network guard (SSRF)
// ---------------------------------------------------------------------------------------------

/**
 * Every request the recording browser makes is checked here: only http(s)/data/blob, and never an
 * address in a private, loopback or link-local range (169.254.169.254 included). Names are resolved
 * and EVERY address is checked. Known gap: Chromium resolves names again itself, so DNS rebinding is
 * only narrowed, not closed — an egress proxy is the complete fix (the plan's follow-ups list it).
 * RECORDER_ALLOW_PRIVATE_NETWORK=true turns the address check off (local development only).
 */
async function guardNetwork(context: BrowserContext): Promise<void> {
  const cache = new Map<string, boolean>();
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (!isAllowedScheme(url)) return route.abort("blockedbyclient");
    let host = "";
    try { host = new URL(url).hostname; } catch { return route.abort("blockedbyclient"); }
    if (!host || allowPrivateNetwork()) return route.continue();
    let blocked = cache.get(host);
    if (blocked === undefined) {
      const bare = host.replace(/^\[|\]$/g, "");
      if (isIP(bare)) blocked = isBlockedAddress(bare);
      else if (host === "localhost" || host.endsWith(".localhost")) blocked = true;
      else {
        try {
          const addrs = await lookup(host, { all: true });
          blocked = addrs.some((a) => isBlockedAddress(a.address));
        } catch { blocked = false; } // unresolvable: Chromium will fail it on its own
      }
      cache.set(host, blocked);
    }
    return blocked ? route.abort("blockedbyclient") : route.continue();
  });
}

// ---------------------------------------------------------------------------------------------
// live view
// ---------------------------------------------------------------------------------------------

async function startScreencast(s: Session): Promise<void> {
  if (s.cdp) await s.cdp.detach().catch(() => {});
  const cdp = await s.context.newCDPSession(s.page);
  s.cdp = cdp;
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number }) => {
    // Ack first: an un-acked frame stops the stream.
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    s.frame = Buffer.from(f.data, "base64");
    s.frameSeq++;
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg", quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1,
  });
}

function wirePage(s: Session, page: Page): void {
  page.on("dialog", (d) => {
    s.notices.push(`The page showed a ${d.type()} ("${d.message().slice(0, 80)}") — it was accepted.`);
    void d.accept().catch(() => {});
  });
}

/** A link that opened a new tab: show that tab from now on, as the person would see it. */
async function adoptPopup(s: Session, p: Page): Promise<void> {
  if (s.closed || p === s.page) return;
  await p.waitForLoadState("domcontentloaded").catch(() => {});
  const old = s.page;
  s.page = p;
  wirePage(s, p);
  await startScreencast(s).catch(() => {});
  await old.close().catch(() => {});
  s.notices.push("A new tab opened; the recording continues in it. The saved test will open that address directly.");
  s.steps = appendAction(s.steps, { kind: "navigate", url: p.url() });
}

/** The latest frame, or null when nothing newer than `after` has arrived. */
export async function latestFrame(s: Session, after: number): Promise<{ jpeg: Buffer; seq: number } | null> {
  // A page that never repainted has sent no frame yet: take one picture so the view is never blank.
  if (!s.frame) {
    await serial(s, async () => {
      if (s.frame) return;
      s.frame = await s.page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
      if (s.frame) s.frameSeq++;
    });
  }
  if (!s.frame || s.frameSeq <= after) return null;
  return { jpeg: s.frame, seq: s.frameSeq };
}

// ---------------------------------------------------------------------------------------------
// naming an element (the part that makes a recording replayable)
// ---------------------------------------------------------------------------------------------

/** Chromium accessibility roles that `getByRole` can address, with Chromium's own spelling mapped. */
const ROLE_ALIASES: Record<string, string> = { image: "img" };
const NAMELESS_ROLES = new Set(["generic", "none", "StaticText", "LabelText", "paragraph", "InlineTextBox",
  "group", "section", "Section", "RootWebArea", "main", "region", "LineBreak", "presentation"]);

/**
 * Plain facts about the element, read in the page. A STRING handed to `new Function`, not a TS
 * function: tsx's `__name` helper does not exist inside the page (TECH_DEBT.md TD-40).
 */
const DESCRIBE = new Function("el", `
  var tag = el.tagName ? el.tagName.toLowerCase() : "";
  var type = (el.getAttribute && (el.getAttribute("type") || "")).toLowerCase();
  var testId = el.getAttribute && (el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test") || "");
  var label = "";
  if (el.labels && el.labels.length) label = (el.labels[0].innerText || el.labels[0].textContent || "").trim();
  var text = ((el.innerText || el.textContent || "") + "").replace(/\\s+/g, " ").trim();
  var options = [];
  if (tag === "select") for (var i = 0; i < el.options.length; i++) options.push({ value: el.options[i].value, label: (el.options[i].label || el.options[i].text || "").trim() });
  return {
    tag: tag, type: type, testId: testId || "", label: label.replace(/\\s+/g, " ").slice(0, 120),
    placeholder: (el.getAttribute && el.getAttribute("placeholder")) || "",
    text: text.length <= 80 ? text : "",
    options: options,
    checked: !!el.checked,
    id: (el.getAttribute && el.getAttribute("id")) || "",
    nameAttr: (el.getAttribute && el.getAttribute("name")) || "",
    isFrame: tag === "iframe" || tag === "frame",
    editable: tag === "textarea" || (tag === "input" && ["button","submit","reset","checkbox","radio","file","image","hidden"].indexOf(type) < 0) || el.isContentEditable === true
  };
`) as (el: Element) => ElementInfo;

interface ElementInfo {
  tag: string; type: string; testId: string; label: string; placeholder: string; text: string;
  options: { value: string; label: string }[]; checked: boolean; id: string; nameAttr: string;
  isFrame: boolean; editable: boolean;
}

/** An id that looks generated per render (React useId ":r1:", long digit runs) is not kept. */
const STABLE_ID = /^[A-Za-z][\w-]{0,60}$/;
const looksGenerated = (id: string) => /\d{4,}|^:|^(radix|headlessui|mui|react)-/i.test(id);

/** The clickable element under a point: through shadow roots, then up to the nearest control. */
const elementAtExpr = (x: number, y: number) => `(() => {
  var el = document.elementFromPoint(${x}, ${y});
  while (el && el.shadowRoot) { var inner = el.shadowRoot.elementFromPoint(${x}, ${y}); if (!inner || inner === el) break; el = inner; }
  if (!el) return null;
  var cur = el;
  for (var i = 0; i < 6 && cur; i++) {
    var t = cur.tagName ? cur.tagName.toLowerCase() : "";
    if (["a","button","input","select","textarea","summary","option","label","iframe"].indexOf(t) >= 0) return cur;
    if (cur.getAttribute && (cur.getAttribute("role") || cur.getAttribute("data-testid") || cur.hasAttribute("onclick") || cur.getAttribute("contenteditable") === "true")) return cur;
    cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
  }
  return el;
})()`;

const ACTIVE_EXPR = `(() => { var a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a && a !== document.body ? a : null; })()`;

/** Chromium's own role and accessible name for an element (exactly what getByRole matches). */
async function axRoleName(s: Session, handle: ElementHandle): Promise<{ role: string; name: string } | null> {
  if (!s.cdp) return null;
  const mark = `tb${randomBytes(4).toString("hex")}`;
  try {
    await handle.evaluate((el, m) => (el as Element).setAttribute("data-tb-pick", m), mark);
    const doc = await s.cdp.send("DOM.getDocument", { depth: 0 }) as { root: { nodeId: number } };
    const q = await s.cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: `[data-tb-pick="${mark}"]` }) as { nodeId: number };
    if (!q.nodeId) return null;
    const ax = await s.cdp.send("Accessibility.getPartialAXTree", { nodeId: q.nodeId, fetchRelatives: false }) as
      { nodes: { role?: { value?: string }; name?: { value?: string }; ignored?: boolean }[] };
    const node = ax.nodes.find((n) => !n.ignored) ?? ax.nodes[0];
    const role = String(node?.role?.value ?? "");
    const name = String(node?.name?.value ?? "").replace(/\s+/g, " ").trim();
    if (!role || NAMELESS_ROLES.has(role) || !name) return null;
    return { role: ROLE_ALIASES[role] ?? role, name };
  } catch {
    return null;
  } finally {
    await handle.evaluate((el) => (el as Element).removeAttribute("data-tb-pick")).catch(() => {});
  }
}

/** Index of `handle` among what `loc` matches, or -1 (also -1 when it matches more than 30). */
async function indexIn(loc: Locator, handle: ElementHandle): Promise<{ index: number; count: number }> {
  const count = await loc.count().catch(() => 0);
  if (count === 0 || count > 30) return { index: -1, count };
  const all = await loc.elementHandles().catch(() => [] as ElementHandle[]);
  let index = -1;
  for (let i = 0; i < all.length && index < 0; i++) {
    if (await all[i].evaluate((a, b) => a === b, handle).catch(() => false)) index = i;
  }
  await Promise.all(all.map((h) => h.dispose().catch(() => {})));
  return { index, count };
}

/**
 * The target a replay will find: the first candidate that resolves to THIS element, checked with
 * the same Playwright locators the generated spec uses. role+name may carry `nth` (the generator
 * honours it); testId/label/placeholder/text only when unique, because the generator ends those
 * with `.first()`.
 */
export async function resolveTarget(s: Session, handle: ElementHandle, info: ElementInfo): Promise<Target | null> {
  const page = s.page;
  if (info.testId) {
    const r = await indexIn(page.getByTestId(info.testId), handle);
    if (r.index === 0 && r.count === 1) return { testId: info.testId };
  }
  const ax = await axRoleName(s, handle);
  if (ax) {
    const r = await indexIn(page.getByRole(ax.role as Parameters<Page["getByRole"]>[0], { name: ax.name, exact: true }), handle);
    if (r.index >= 0) return r.count > 1 ? { role: ax.role, name: ax.name, nth: r.index } : { role: ax.role, name: ax.name };
  }
  if (info.label) {
    const r = await indexIn(page.getByLabel(info.label, { exact: true }), handle);
    if (r.index === 0 && r.count === 1) return { label: info.label };
  }
  if (info.placeholder) {
    const r = await indexIn(page.getByPlaceholder(info.placeholder, { exact: true }), handle);
    if (r.index === 0 && r.count === 1) return { placeholder: info.placeholder };
  }
  if (info.text) {
    const r = await indexIn(page.getByText(info.text, { exact: true }), handle);
    if (r.index === 0 && r.count === 1) return { text: info.text };
  }
  // Last: a box with no accessible name at all, by its id or name attribute — observed on the live
  // page and checked unique here, never guessed (the generator resolves `css` as written).
  const css: string[] = [];
  if (info.id && STABLE_ID.test(info.id) && !looksGenerated(info.id)) css.push(`#${info.id}`);
  if (info.nameAttr && /^[\w.\-[\]]{1,80}$/.test(info.nameAttr)) css.push(`${info.tag}[name="${info.nameAttr}"]`);
  for (const sel of css) {
    const r = await indexIn(page.locator(sel), handle);
    if (r.index === 0 && r.count === 1) return { css: sel };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------------------------

function record(s: Session, action: RecordedAction): void { s.steps = appendAction(s.steps, action); }

/**
 * Write the box's current value into the steps. Called straight after EVERY keystroke batch, not
 * only when the person moves on: a framework that re-renders the box (a React modal does) detaches
 * the handle we hold, and a value read only "later" was then lost — the step vanished, or landed
 * after the next click. Consecutive fills of one box merge (appendAction), so this costs no steps.
 * When the handle is gone, the box that has focus now is read instead.
 */
async function captureTyped(s: Session): Promise<void> {
  const t = s.typing;
  if (!t) return;
  if (t.secret) { record(s, { kind: "fill", target: t.target, value: "", secret: true }); return; }
  // A box the page has removed still answers with its OLD value, so a detached one reads as null.
  const read = (h: ElementHandle) => h.evaluate((el) => {
    const e = el as HTMLInputElement;
    if (!e.isConnected) return null;
    return typeof e.value === "string" ? e.value : (e.textContent ?? "");
  });
  let value = await read(t.handle).catch(() => null);
  if (value === null) {
    const active = (await s.page.evaluateHandle(ACTIVE_EXPR).catch(() => null))?.asElement() as ElementHandle | null;
    if (active) {
      value = await read(active).catch(() => null);
      await t.handle.dispose().catch(() => {});
      t.handle = active;
    }
  }
  if (value !== null) t.value = value;
  if (t.value !== null) record(s, { kind: "fill", target: t.target, value: t.value, secret: false });
}

/** Record what has been typed so far. `end` also forgets the box (the person moved on). */
async function flushTyping(s: Session, end: boolean): Promise<void> {
  const t = s.typing;
  if (!t) return;
  await captureTyped(s);
  if (end) { await t.handle.dispose().catch(() => {}); s.typing = null; }
}

async function beginTyping(s: Session): Promise<boolean> {
  const active = (await s.page.evaluateHandle(ACTIVE_EXPR)).asElement() as ElementHandle | null;
  if (!active) return false;
  if (s.typing && await s.typing.handle.evaluate((a, b) => a === b, active).catch(() => false)) {
    await active.dispose().catch(() => {});
    return true;
  }
  await flushTyping(s, true);
  const info = await active.evaluate(DESCRIBE).catch(() => null);
  if (!info?.editable) { await active.dispose().catch(() => {}); return false; }
  const target = await resolveTarget(s, active, info);
  if (!target) {
    s.notices.push("Typing into a box that could not be named — it was not recorded.");
    await active.dispose().catch(() => {});
    return false;
  }
  s.typing = { handle: active, target, secret: info.type === "password", value: null };
  return true;
}

const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v)));

async function onClick(s: Session, xf: number, yf: number): Promise<void> {
  await flushTyping(s, true);
  const x = clamp(xf * VIEWPORT.width, VIEWPORT.width);
  const y = clamp(yf * VIEWPORT.height, VIEWPORT.height);
  const handle = (await s.page.evaluateHandle(elementAtExpr(x, y)).catch(() => null))?.asElement() as ElementHandle | null;
  const info = handle ? await handle.evaluate(DESCRIBE).catch(() => null) : null;

  if (!handle || !info) { await s.page.mouse.click(x, y); return; }
  if (info.isFrame) {
    s.notices.push("Clicks inside an embedded frame are not recorded yet — the click still happened.");
    await s.page.mouse.click(x, y);
    return;
  }

  const target = await resolveTarget(s, handle, info);

  if (s.checkMode) {
    if (target) record(s, { kind: "assert_visible", target });
    else if (info.text) record(s, { kind: "assert_text", text: info.text });
    else s.notices.push("Nothing nameable there to check.");
    await handle.dispose().catch(() => {});
    return; // a check does not click
  }

  if (info.tag === "select") {
    // A native dropdown is not part of the screencast: the page offers the options instead.
    s.pendingSelect = { handle, target, options: info.options };
    return;
  }

  await s.page.mouse.click(x, y);
  if (!target) {
    s.notices.push(info.text ? `Clicked "${info.text.slice(0, 40)}", but it could not be named uniquely — not recorded.` : "That click could not be named — not recorded.");
  } else if (info.tag === "input" && (info.type === "checkbox" || info.type === "radio")) {
    record(s, { kind: "check", target });
  } else if (!info.editable) {
    record(s, { kind: "click", target });
  } else {
    record(s, { kind: "click", target }); // dropped again if typing into this box follows
  }
  await handle.dispose().catch(() => {});
}

const RECORDED_KEYS = new Set(["Enter", "Escape"]);

export function handleInput(s: Session, events: RecorderInput[]): Promise<void> {
  return serial(s, async () => {
    for (const ev of events) {
      switch (ev.type) {
        case "click":
          await onClick(s, ev.x, ev.y);
          break;
        case "text":
          if (!ev.text) break;
          await beginTyping(s);
          await s.page.keyboard.insertText(ev.text);
          await captureTyped(s);
          break;
        case "key": {
          if (RECORDED_KEYS.has(ev.key)) {
            await flushTyping(s, true);
            await s.page.keyboard.press(ev.key);
            record(s, { kind: "press", key: ev.key });
          } else if (ev.key === "Tab" || ev.key === "Shift+Tab") {
            await flushTyping(s, true);
            await s.page.keyboard.press(ev.key);
          } else {
            // Backspace, Delete, arrows, Ctrl+A …: they change the box, so its value is read again.
            await s.page.keyboard.press(ev.key);
            await captureTyped(s);
          }
          break;
        }
        case "scroll":
          await s.page.mouse.wheel(ev.dx ?? 0, ev.dy);
          break;
        case "navigate":
          await flushTyping(s, true);
          await s.page.goto(ev.url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((err) => {
            s.notices.push(`Could not open ${ev.url}: ${(err as Error).message.split("\n")[0]}`);
          });
          record(s, { kind: "navigate", url: s.page.url() });
          break;
        case "back":
          await flushTyping(s, true);
          await s.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
          record(s, { kind: "navigate", url: s.page.url() });
          break;
        case "select": {
          const p = s.pendingSelect;
          if (!p) break;
          s.pendingSelect = null;
          await p.handle.selectOption(ev.value).catch(() => {});
          if (p.target) record(s, { kind: "select", target: p.target, value: p.options.find((o) => o.value === ev.value)?.label || ev.value });
          else s.notices.push("That dropdown could not be named — the choice was made but not recorded.");
          await p.handle.dispose().catch(() => {});
          break;
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// state, check mode, undo, the final steps
// ---------------------------------------------------------------------------------------------

export async function recordingState(s: Session) {
  await serial(s, () => flushTyping(s, false));
  const notices = s.notices.splice(0);
  return {
    id: s.id,
    projectId: s.projectId,
    url: s.page.url(),
    title: await s.page.title().catch(() => ""),
    viewport: VIEWPORT,
    frameSeq: s.frameSeq,
    checkMode: s.checkMode,
    steps: stepsAsText(s.steps),
    pendingSelect: s.pendingSelect ? { options: s.pendingSelect.options } : null,
    notices,
  };
}

export function setCheckMode(s: Session, on: boolean): void { s.checkMode = on; }

export function undoLastStep(s: Session): Promise<void> {
  return serial(s, async () => {
    await flushTyping(s, true);
    if (s.steps.length > 1) s.steps = s.steps.slice(0, -1); // the first navigate stays
  });
}

/** The recorded steps as they stand (typing in progress included). */
export function finalSteps(s: Session): Promise<Step[]> {
  return serial(s, async () => { await flushTyping(s, true); return s.steps.map((x) => ({ ...x })); });
}
