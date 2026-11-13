import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extendAppModel } from "../src/stages/liveExtend.js";
import { buildLoginPrefix } from "../src/stages/ir.js";
import type { AppModel, AuthOutcome } from "../src/schema/appModel.js";
import type { Step } from "../src/schema/ir.js";

/**
 * The grounding walk (liveExtend's replay) waits for the recorded login to land.
 *
 * Run 2026-11-13T06-48-25-868Z-a3842ef7 (learnvibes): the recorded login's submit is
 * `button[type="submit"]` — no accessible name — so `isAuthTriggeringStep` did not fire, and the
 * prefix's own "the password box is gone" settle step was skipped like every other assert. The
 * walk navigated on while the sign-in request was in flight, bounced to the login page, and could
 * not click "Admin": /admin was never captured, so "Users" / "Add New" could not be grounded,
 * although the executed spec (which does wait on that step) reached /admin.
 *
 * A real Chromium against a throwaway server whose sign-in takes 1.5 s: no network, no LLM, no
 * real credentials. Verified both ways when written: with the settle step the walk reaches /admin;
 * without it, the click times out exactly as in the run.
 */

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const guard = `<script>if(!localStorage.getItem('auth')) location.replace('/login');</script>`;
const routes: Record<string, string> = {
  "/login": page(`<h1>Sign in</h1><form id="f"><input id="email" placeholder="email"><input type="password" placeholder="pw"><button type="submit"></button></form>
    <script>document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();
      setTimeout(()=>{localStorage.setItem('auth','1');location.replace('/');},1500);});</script>`),
  "/": page(`${guard}<h1>Dashboard</h1><nav><button onclick="location.href='/admin'">Admin</button><button>Home</button></nav>`),
  "/admin": page(`${guard}<h1>Admin Panel</h1><button>Users</button><button>Add New</button>`),
};

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = routes[(req.url || "/").split("?")[0]];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("the grounding walk waits for the recorded login before going on", () => {
  it("reaches a signed-in-only page after a login whose submit has no name", async () => {
    const auth = {
      status: "authenticated", url: `${base}/`, loginUrl: `${base}/login`,
      loginSteps: [
        { action: "fill", css: "#email", credential: "username" },
        { action: "fill", css: 'input[placeholder="pw"]', credential: "password" },
        { action: "click", css: 'button[type="submit"]' },
      ],
    } as AuthOutcome;
    const model = {
      baseUrl: base, auth,
      pages: [
        { url: `${base}/login`, concepts: [], elements: [{ role: "textbox", name: "email" }] },
        { url: `${base}/`, concepts: [], elements: [{ role: "button", name: "Admin" }, { role: "button", name: "Home" }] },
      ],
    } as unknown as AppModel;
    const prefix: Step[] = [
      ...buildLoginPrefix(auth),
      { id: "s1", action: "navigate", target: { url: "/" } } as Step,
      { id: "s2", action: "click", target: { role: "button", name: "Admin" } } as Step,
    ];
    // Unique credentials, so the walk cache (keyed on a credential digest) never serves an old entry.
    const extended = await extendAppModel(model, prefix, { username: "a@b.c", password: `pw-${Date.now()}` }, "full");
    const reached = extended.pages.at(-1)!;
    expect(new URL(reached.url).pathname).toBe("/admin");
    expect(reached.elements.filter((e) => e.role === "button").map((e) => e.name)).toEqual(
      expect.arrayContaining(["Users", "Add New"]),
    );
  }, 60_000);
});
