import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeRecording, finalSteps, getRecording, handleInput, recordingState, setCheckMode, startRecording, VIEWPORT,
} from "../src/server/recorderSessions.js";
import { PASSWORD_REF, stepsAsText, USERNAME_REF, withCredentialRefs } from "../src/stages/recorder.js";

/**
 * The browser half for real (DECISIONS.md D-19: a Playwright expression is not verified until it
 * runs): a real Chromium, a synthetic login page on 127.0.0.1, and input sent exactly as the React
 * page sends it — fractions of the screen.
 */
const PAGE = `<!doctype html><html><head><title>Shop</title></head><body>
<h1>Sign in</h1>
<form id="f">
  <label for="e">Email</label> <input id="e" type="email"><br>
  <label for="p">Password</label> <input id="p" type="password"><br>
  <label><input type="checkbox" id="r"> Remember me</label><br>
  <select id="c" aria-label="Country"><option value="in">India</option><option value="us">United States</option></select><br>
  <button type="submit">Sign In</button>
</form>
<script>document.getElementById("f").addEventListener("submit", function (e) {
  e.preventDefault(); document.body.innerHTML = "<h1>Welcome back</h1><button>Log out</button>";
});</script>
</body></html>`;

/**
 * A box that is REPLACED by a new element on every keystroke (what a re-rendering modal does), a box
 * with no accessible name at all (only `name=`), and a Save button. The bug this pins: the typed
 * value was read only when the person moved on, from a handle the re-render had detached — so the
 * step was lost, or landed after the next click.
 */
const REMOUNT = `<!doctype html><html><head><title>New module</title></head><body>
<div role="dialog" aria-label="New module">
  <div id="slot"><input placeholder="Module title"></div>
  <input name="code" style="display:block">
  <button>Save</button>
</div>
<script>
  document.getElementById("slot").addEventListener("input", function (e) {
    var old = e.target, fresh = document.createElement("input");
    fresh.placeholder = "Module title"; fresh.value = old.value;
    old.replaceWith(fresh); fresh.focus(); fresh.setSelectionRange(fresh.value.length, fresh.value.length);
  });
</script></body></html>`;

let server: Server;
let base = "";
const prevAllow = process.env.RECORDER_ALLOW_PRIVATE_NETWORK;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url?.startsWith("/remount") ? REMOUNT : PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  process.env.RECORDER_ALLOW_PRIVATE_NETWORK = prevAllow;
  await new Promise<void>((r) => server.close(() => r()));
});

/** The centre of an element, as the fractions the React page sends. */
async function at(s: ReturnType<typeof getRecording>, selector: string) {
  const box = await s.page.locator(selector).boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: (box.x + box.width / 2) / VIEWPORT.width, y: (box.y + box.height / 2) / VIEWPORT.height };
}

describe("recorder session in a real browser", () => {
  it("records a login, a checkbox, a dropdown and a check as replayable steps", async () => {
    process.env.RECORDER_ALLOW_PRIVATE_NETWORK = "true";
    const id = await startRecording({ userId: "u1", orgId: "o1", projectId: "p1", url: base });
    const s = getRecording(id, "u1", "o1");
    try {
      await handleInput(s, [{ type: "click", ...(await at(s, "#e")) }, { type: "text", text: "a@b.com" }]);
      await handleInput(s, [{ type: "click", ...(await at(s, "#p")) }, { type: "text", text: "s3cret!" }]);
      await handleInput(s, [{ type: "click", ...(await at(s, "#r")) }]);
      await handleInput(s, [{ type: "click", ...(await at(s, "#c")) }]);
      expect((await recordingState(s)).pendingSelect?.options.map((o) => o.label)).toEqual(["India", "United States"]);
      await handleInput(s, [{ type: "select", value: "us" }]);
      await handleInput(s, [{ type: "click", ...(await at(s, "button")) }]);
      await s.page.getByRole("heading", { name: "Welcome back" }).waitFor();
      setCheckMode(s, true);
      await handleInput(s, [{ type: "click", ...(await at(s, "h1")) }]);

      // The password reached the page (it was really typed) …
      expect(await s.page.locator("body").innerText()).toContain("Welcome back");
      const steps = withCredentialRefs(await finalSteps(s));
      expect(stepsAsText(steps).map((x) => x.text)).toEqual([
        `Go to ${base}`,
        `Type "${USERNAME_REF}" into textbox "Email"`,
        `Type "${PASSWORD_REF}" into textbox "Password"`,
        'Check checkbox "Remember me"',
        'Choose "United States" from combobox "Country"',
        'Click on button "Sign In"',
        'Check that heading "Welcome back" appears on the page',
      ]);
      // … but never into a step (CLAUDE.md rule 5).
      expect(JSON.stringify(await finalSteps(s))).not.toContain("s3cret!");
    } finally {
      await closeRecording(s);
    }
  }, 90_000);

  it("keeps typed text when the box is re-rendered on every key, and records it before the next click", async () => {
    process.env.RECORDER_ALLOW_PRIVATE_NETWORK = "true";
    const id = await startRecording({ userId: "u1", orgId: "o1", projectId: "p1", url: `${base}remount` });
    const s = getRecording(id, "u1", "o1");
    try {
      await handleInput(s, [{ type: "click", ...(await at(s, "#slot input")) }]);
      // One letter per request, as a person types: every letter remounts the box.
      for (const ch of "Intro") await handleInput(s, [{ type: "text", text: ch }]);
      await handleInput(s, [{ type: "key", key: "Backspace" }]);
      await handleInput(s, [{ type: "click", ...(await at(s, "input[name=code]")) }, { type: "text", text: "M-01" }]);
      await handleInput(s, [{ type: "click", ...(await at(s, "button")) }]);
      expect(stepsAsText(await finalSteps(s)).map((x) => x.text)).toEqual([
        `Go to ${base}remount`,
        'Type "Intr" into textbox "Module title"',
        'Type "M-01" into input[name="code"]',
        'Click on button "Save"',
      ]);
    } finally {
      await closeRecording(s);
    }
  }, 90_000);

  it("only the user and organisation that started a recording can reach it", async () => {
    process.env.RECORDER_ALLOW_PRIVATE_NETWORK = "true";
    const id = await startRecording({ userId: "u1", orgId: "o1", projectId: "p1", url: base });
    try {
      expect(() => getRecording(id, "u2", "o1")).toThrow(/no such recording/);
      expect(() => getRecording(id, "u1", "o2")).toThrow(/no such recording/);
      expect(getRecording(id, "u1", "o1").id).toBe(id);
    } finally {
      await closeRecording(getRecording(id, "u1", "o1"));
    }
    expect(() => getRecording(id, "u1", "o1")).toThrow(/no such recording/);
  }, 60_000);

  it("refuses to load a private address unless local development allows it", async () => {
    process.env.RECORDER_ALLOW_PRIVATE_NETWORK = "false";
    const id = await startRecording({ userId: "u1", orgId: "o1", projectId: "p1", url: base });
    const s = getRecording(id, "u1", "o1");
    try {
      const state = await recordingState(s);
      expect(state.notices.join(" ")).toMatch(/Could not open the page/);
      expect(await s.page.content()).not.toContain("Sign in");
    } finally {
      await closeRecording(s);
    }
  }, 60_000);
});
