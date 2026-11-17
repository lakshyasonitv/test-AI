/**
 * Record a test (D-86, RECORDER_ENABLED, default off).
 *
 * A person does the flow once in a real browser that runs ON THE SERVER, seen in the page as a polled
 * screenshot; every click and keystroke is performed there and stored as an IR step carrying the
 * element's real identity — the browser's own accessible role and name, plus css, test id and
 * placeholder as backups. The result is an ordinary IR, so the existing generator, executor and
 * zero-LLM replay run it unchanged.
 *
 * Why (2026-11-17, eventrix.tech): a whole day of runs failed on names discovery GUESSED from page text
 * ("Technical ConferencesTracks…" glued, cut at 80 characters) that the browser never uses. A recording
 * reads the identity from the element the person actually clicked, at the moment they clicked it.
 *
 * Credentials (CLAUDE.md platform rule 5): a password typed into the page is stored as
 * `${env:TEST_PASSWORD}`, and the identifier of a sign-in form as `${env:TEST_USERNAME}`. The real
 * values reach the page through the keyboard and are never kept. Screenshots are served, never written.
 *
 * Headless on purpose: production (an Azure container) has no display, so a desktop recorder or a
 * headed browser cannot work there; a browser extension would need installing on every machine.
 */
import crypto from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { IR, type Step } from "../schema/ir.js";
import { chromiumLaunchOptions } from "../browserLaunch.js";

export const recorderEnabled = (): boolean => process.env.RECORDER_ENABLED === "true";
const MAX_SESSIONS = (): number => Number(process.env.RECORDER_MAX_SESSIONS ?? 2);
const IDLE_MS = (): number => Number(process.env.RECORDER_IDLE_MS ?? 10 * 60 * 1000);
export const RECORDER_VIEWPORT = { width: 1280, height: 720 };

export type RecorderMode = "act" | "check";

export interface RecorderInput {
  type: "click" | "type" | "key" | "scroll" | "navigate";
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  dy?: number;
  url?: string;
  /** "check": a click records an assertion that the element is visible, and does not click. */
  mode?: RecorderMode;
}

interface Session {
  id: string;
  owner: string;
  startUrl: string;
  browser: Browser;
  page: Page;
  steps: Step[];
  lastUsed: number;
  timer: NodeJS.Timeout;
}

const sessions = new Map<string, Session>();

export class RecorderError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** What the page says about the element a recording acts on (computed in the page, see identify()). */
interface Identity {
  tag: string;
  inputType: string;
  css: string;
  testId: string;
  placeholder: string;
  text: string;
  interactive: boolean;
  isPassword: boolean;
  isIdentifier: boolean;
  value: string;
}

/** Keys worth a step of their own; ordinary characters arrive as "type". */
const RECORDED_KEYS = new Set(["Enter", "Tab", "Escape"]);

function touch(s: Session): void {
  s.lastUsed = Date.now();
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { void closeRecording(s.id); }, IDLE_MS());
}

function sessionFor(id: string, owner: string): Session {
  const s = sessions.get(id);
  // Same answer for "no such recording" and "someone else's": an id is not a capability to probe.
  if (!s || s.owner !== owner) throw new RecorderError(404, "no such recording");
  touch(s);
  return s;
}

export async function startRecording(owner: string, url: string): Promise<{ id: string; viewport: typeof RECORDER_VIEWPORT }> {
  let start: URL;
  try { start = new URL(url); } catch { throw new RecorderError(400, "url must be an absolute http(s) address"); }
  if (start.protocol !== "http:" && start.protocol !== "https:") throw new RecorderError(400, "url must be an absolute http(s) address");
  if (sessions.size >= MAX_SESSIONS()) throw new RecorderError(429, `at most ${MAX_SESSIONS()} recordings at once — stop one first`);

  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: RECORDER_VIEWPORT });
    await page.goto(start.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const id = crypto.randomUUID();
    const s: Session = {
      id, owner, startUrl: start.href, browser, page, lastUsed: Date.now(),
      steps: [{ id: "s1", action: "navigate", target: { url: start.href } }],
      timer: setTimeout(() => {}, 0),
    };
    sessions.set(id, s);
    touch(s);
    return { id, viewport: RECORDER_VIEWPORT };
  } catch (err) {
    await browser.close().catch(() => {});
    throw new RecorderError(502, `could not open ${start.href}: ${(err as Error).message.split("\n")[0]}`);
  }
}

/** The live view: a JPEG of the page as it is now. Never written to disk. */
export async function recordingFrame(id: string, owner: string): Promise<Buffer> {
  const s = sessionFor(id, owner);
  return s.page.screenshot({ type: "jpeg", quality: 60 });
}

export function recordingState(id: string, owner: string): { url: string; steps: Step[] } {
  const s = sessionFor(id, owner);
  return { url: s.page.url(), steps: s.steps };
}

/**
 * Mark and describe the element at (x, y) — or, with no point, the focused element — in the page.
 *
 * Everything is inlined in the callback, no named or const-assigned functions: tsx (esbuild) wraps
 * those in a `__name()` helper that does not exist inside the code page.evaluate ships to the browser,
 * and the call throws only on a real `npm run serve` (CLAUDE.md, TECH_DEBT.md TD-40).
 */
async function identify(page: Page, point: { x: number; y: number } | null, mark: string): Promise<Identity | null> {
  return page.evaluate(({ point, mark }) => {
    let el: Element | null = point ? document.elementFromPoint(point.x, point.y) : document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const ROLES = ["button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch", "combobox", "textbox", "searchbox"];
    const TAGS = ["a", "button", "input", "select", "textarea", "summary"];
    let hit: Element | null = null;
    let cur: Element | null = el;
    for (let i = 0; cur && i < 8; i++) {
      const tag = cur.tagName.toLowerCase();
      const role = cur.getAttribute("role") || "";
      if (TAGS.includes(tag) || ROLES.includes(role) || cur.hasAttribute("onclick") || cur.getAttribute("tabindex") === "0") { hit = cur; break; }
      cur = cur.parentElement;
    }
    // A click on a <label> acts on its control.
    if (hit && hit.tagName.toLowerCase() === "label" && (hit as HTMLLabelElement).control) hit = (hit as HTMLLabelElement).control;
    const target = (hit || el) as HTMLElement;
    target.setAttribute("data-tb-rec", mark);

    // A css selector: a unique id when there is one, else a short tag:nth-of-type path.
    let css = "";
    if (target.id && /^[A-Za-z][\w-]*$/.test(target.id) && document.querySelectorAll("#" + target.id).length === 1) {
      css = "#" + target.id;
    } else {
      const parts: string[] = [];
      let node: Element | null = target;
      for (let depth = 0; node && node !== document.body && depth < 6; depth++) {
        const tag = node.tagName.toLowerCase();
        if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && document.querySelectorAll("#" + node.id).length === 1) { parts.unshift("#" + node.id); break; }
        let index = 1;
        let sib = node.previousElementSibling;
        while (sib) { if (sib.tagName === node.tagName) index++; sib = sib.previousElementSibling; }
        parts.unshift(tag + ":nth-of-type(" + index + ")");
        node = node.parentElement;
      }
      css = parts.join(" > ");
      if (css && document.querySelectorAll(css).length !== 1) css = "";
    }

    const tag = target.tagName.toLowerCase();
    const inputType = (target.getAttribute("type") || "").toLowerCase();
    const auto = (target.getAttribute("autocomplete") || "").toLowerCase();
    const form = target.closest("form") || document;
    const hasPassword = !!form.querySelector('input[type="password"]');
    return {
      tag,
      inputType,
      css,
      testId: target.getAttribute("data-testid") || target.getAttribute("data-test") || target.getAttribute("data-test-id") || "",
      placeholder: target.getAttribute("placeholder") || "",
      text: (target.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200),
      interactive: !!hit,
      isPassword: tag === "input" && inputType === "password",
      isIdentifier: tag === "input" && hasPassword && inputType !== "password"
        && (inputType === "email" || /username|email/.test(auto) || /user|email|login/i.test(target.getAttribute("name") || target.id || "")),
      value: "value" in target ? String((target as HTMLInputElement).value ?? "") : "",
    };
  }, { point, mark });
}

/** The browser's own accessible role and name for the marked element (what getByRole matches). */
async function accessibleOf(page: Page, mark: string): Promise<{ role?: string; name?: string; nth?: number }> {
  const loc = page.locator(`[data-tb-rec="${mark}"]`);
  const snap = await loc.ariaSnapshot({ timeout: 2000 }).catch(() => "");
  const first = snap.split("\n")[0] ?? "";
  const m = /^-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(first);
  if (!m || !m[2]) return m ? { role: m[1] } : {};
  const role = m[1];
  const name = m[2].replace(/\\(.)/g, "$1");
  // Several elements with this exact role + name: which one, in page order.
  const index = await page.getByRole(role as any, { name, exact: true })
    .evaluateAll((els) => els.findIndex((e) => e.hasAttribute("data-tb-rec"))).catch(() => -1);
  const count = await page.getByRole(role as any, { name, exact: true }).count().catch(() => 0);
  return { role, name, ...(count > 1 && index >= 0 ? { nth: index } : {}) };
}

async function unmark(page: Page, mark: string): Promise<void> {
  await page.evaluate((mark) => {
    document.querySelectorAll('[data-tb-rec="' + mark + '"]').forEach((e) => e.removeAttribute("data-tb-rec"));
  }, mark).catch(() => {});
}

/** Every way to find the element, best first: role + name, then the backups the runner can fall to. */
function targetOf(idn: Identity, acc: { role?: string; name?: string; nth?: number }): NonNullable<Step["target"]> {
  const t: NonNullable<Step["target"]> = {};
  if (acc.role && acc.name) {
    t.role = acc.role;
    t.name = acc.name;
    if (acc.nth !== undefined) t.nth = acc.nth;
  } else if (!idn.interactive && idn.text) {
    t.text = idn.text;
  }
  // The runner tries css FIRST when a step has one, so a positional path (div:nth-of-type(3) > …), which
  // breaks as soon as a list changes, is kept only when there is no role + name to go by. A unique #id
  // is stable, so it is always kept.
  if (idn.css && (/^#[\w-]+$/.test(idn.css) || !t.role)) t.css = idn.css;
  if (idn.testId) t.testId = idn.testId;
  if (idn.placeholder) t.placeholder = idn.placeholder;
  return t;
}

const sameTarget = (a?: Step["target"], b?: Step["target"]): boolean =>
  !!a && !!b && (a.css ?? "") === (b.css ?? "") && (a.role ?? "") === (b.role ?? "") && (a.name ?? "") === (b.name ?? "");

function push(s: Session, step: Omit<Step, "id">): Step {
  const full = { ...step, id: `s${s.steps.length + 1}` } as Step;
  s.steps.push(full);
  return full;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
}

/**
 * Perform one input in the recorded browser and store the step it means. Returns the step written or
 * changed, or null for an input that records nothing (a scroll, an unidentifiable click).
 */
export async function recordInput(id: string, owner: string, input: RecorderInput): Promise<Step | null> {
  const s = sessionFor(id, owner);
  const page = s.page;
  const mark = crypto.randomBytes(4).toString("hex");

  if (input.type === "scroll") {
    await page.mouse.wheel(0, Math.max(-5000, Math.min(5000, Number(input.dy) || 0)));
    return null;
  }

  if (input.type === "navigate") {
    let url: URL;
    try { url = new URL(String(input.url), page.url()); } catch { throw new RecorderError(400, "bad url"); }
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return push(s, { action: "navigate", target: { url: url.href } });
  }

  if (input.type === "click") {
    const x = Number(input.x), y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RecorderError(400, "click needs x and y");
    const idn = await identify(page, { x, y }, mark);
    if (!idn) {
      if (input.mode !== "check") await page.mouse.click(x, y);
      return null;
    }
    const acc = await accessibleOf(page, mark);
    await unmark(page, mark);
    const target = targetOf(idn, acc);
    if (input.mode === "check") {
      return push(s, { action: "assert", target, assertion: "visible" });
    }
    await page.mouse.click(x, y);
    await settle(page);
    // A click on a field is how typing starts; the fill that follows is the step.
    if (["input", "textarea"].includes(idn.tag) && !["checkbox", "radio", "submit", "button"].includes(idn.inputType)) return null;
    if (idn.tag === "input" && idn.inputType === "checkbox") return push(s, { action: "check", target });
    return push(s, { action: "click", target });
  }

  if (input.type === "type") {
    const text = String(input.text ?? "");
    if (!text) return null;
    const idn = await identify(page, null, mark);
    if (!idn) { await page.keyboard.type(text); return null; }
    const acc = await accessibleOf(page, mark);
    await page.keyboard.type(text);
    // After typing: the field's whole value is what a replay types (an edit in the middle included).
    const after = await page.locator(`[data-tb-rec="${mark}"]`).inputValue({ timeout: 1000 }).catch(() => idn.value + text);
    await unmark(page, mark);
    const target = targetOf(idn, acc);
    const value = idn.isPassword ? "${env:TEST_PASSWORD}" : idn.isIdentifier ? "${env:TEST_USERNAME}" : after;
    const last = s.steps[s.steps.length - 1];
    if (last?.action === "fill" && sameTarget(last.target, target)) {
      last.value = value;
      return last;
    }
    return push(s, { action: "fill", target, value });
  }

  if (input.type === "key") {
    const key = String(input.key ?? "");
    if (!key) throw new RecorderError(400, "key needs a key");
    const idn = RECORDED_KEYS.has(key) ? await identify(page, null, mark) : null;
    const acc = idn ? await accessibleOf(page, mark) : {};
    if (idn) await unmark(page, mark);
    await page.keyboard.press(key);
    if (!RECORDED_KEYS.has(key)) {
      // Backspace and the like change the field: keep the fill step's value in step with the page.
      const last = s.steps[s.steps.length - 1];
      if (last?.action === "fill" && last.value && !/^\$\{env:/.test(last.value)) {
        const now = await page.evaluate(() => {
          const a = document.activeElement as HTMLInputElement | null;
          return a && "value" in a ? String(a.value) : null;
        }).catch(() => null);
        if (now !== null) last.value = now;
      }
      return null;
    }
    await settle(page);
    return push(s, { action: "press", ...(idn ? { target: targetOf(idn, acc) } : {}), value: key });
  }

  throw new RecorderError(400, `unknown input type "${(input as any).type}"`);
}

/** Remove the last step (a mis-click): the page is not rolled back, only the recording. */
export function undoLastStep(id: string, owner: string): Step[] {
  const s = sessionFor(id, owner);
  if (s.steps.length > 1) s.steps.pop();
  return s.steps;
}

/** End the recording: the IR it produced, validated against the schema every stage reads. */
export async function stopRecording(id: string, owner: string, title?: string): Promise<IR> {
  const s = sessionFor(id, owner);
  const ir = buildRecordedIr(s.startUrl, s.steps, title);
  await closeRecording(id);
  return ir;
}

export function buildRecordedIr(startUrl: string, steps: Step[], title?: string): IR {
  const origin = new URL(startUrl).origin;
  return IR.parse({
    meta: {
      feature: "Recorded",
      title: (title ?? "").trim() || `Recorded flow on ${new URL(startUrl).host}`,
      priority: "high",
      sourcePrompt: "Recorded in Testbench (RECORDER_ENABLED)",
      baseUrl: origin,
    },
    steps: steps.map((st, i) => ({ ...st, id: `s${i + 1}` })),
  });
}

export async function closeRecording(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  clearTimeout(s.timer);
  await s.browser.close().catch(() => {});
}

/** For tests and shutdown. */
export async function closeAllRecordings(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => closeRecording(id)));
}
