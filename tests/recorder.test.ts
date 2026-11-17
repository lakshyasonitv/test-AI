import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";

// D-86 Record a test. A real Chromium session driven through the real routes, on a site shaped like the
// one that motivated it (eventrix.tech, 2026-11-17): a sign-in form, template cards built from blocks
// that render late, and a two-screen wizard on ONE url whose title box has only a placeholder.
// The recording is then replayed on a fresh page with nothing but the stored steps.

const LOGIN = `<!doctype html><title>Login</title><body><form id="f">
  <label for="email">Email Address</label><input id="email" type="email" name="email">
  <label for="password">Password</label><input id="password" type="password" name="password">
  <button type="submit">Sign In to Dashboard</button></form>
  <script>document.getElementById("f").onsubmit = (e) => { e.preventDefault(); location.href = "/create"; };</script></body>`;

const CREATE = `<!doctype html><title>Create</title><body><main id="m"><h1>Create an Event</h1><div id="grid"></div></main><script>
  setTimeout(() => {
    document.getElementById("grid").innerHTML =
      '<button id="tc"><span style="display:block">Conference</span><h3>Technical Conferences</h3><p>Tracks, keynote speakers, sponsor tiers.</p></button>' +
      '<button id="hk"><span style="display:block">Hackathon</span><h3>Hackathons</h3><p>Prize pools and judging.</p></button>';
    document.getElementById("tc").onclick = () => {
      document.getElementById("m").innerHTML =
        '<h2>Basics</h2><div>EVENT TITLE *</div><div><input id="title" placeholder="e.g. Global AI Summit"></div>' +
        '<button id="off"><b style="display:block">In-Person</b><span>At a venue</span></button>' +
        '<button id="hyb"><b style="display:block">Hybrid Format</b><span>Both physical and virtual</span></button>' +
        '<button id="c1">Continue</button>';
      document.getElementById("hyb").onclick = () => document.getElementById("hyb").setAttribute("aria-pressed", "true");
      document.getElementById("c1").onclick = () => {
        const t = document.getElementById("title").value;
        document.getElementById("m").innerHTML =
          '<h2>Venue and Time</h2><input id="city" placeholder="City"><button id="pub">Publish</button><p id="out"></p>';
        document.getElementById("pub").onclick = () => {
          document.getElementById("out").textContent = "Event published: " + t + " in " + document.getElementById("city").value;
        };
      };
    };
  }, 600);
</script></body>`;

let server: http.Server;
let base = "";
let app: any;
let request: any;
let browser: Browser;
let mirror: Page;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/login")) res.end(LOGIN);
    else if (req.url?.startsWith("/create")) res.end(CREATE);
    else { res.statusCode = 404; res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.RECORDER_ENABLED = "true";
  ({ app } = await import("../src/server/index.js"));
  request = (await import("supertest")).default;
  browser = await chromium.launch();
  // A mirror page with the same viewport: where to click is read here, then the same click is recorded.
  mirror = await browser.newPage({ viewport: { width: 1280, height: 720 } });
});

afterAll(async () => {
  delete process.env.RECORDER_ENABLED;
  const { closeAllRecordings } = await import("../src/server/recorder.js");
  await closeAllRecordings();
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

/** The centre of `selector` on the mirror page. */
async function at(selector: string): Promise<{ x: number; y: number }> {
  const box = (await mirror.locator(selector).boundingBox({ timeout: 5000 }))!;
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

describe("Record a test (RECORDER_ENABLED)", () => {
  it("is off unless the flag is on: 404, and no browser is opened", async () => {
    delete process.env.RECORDER_ENABLED;
    try {
      const res = await request(app).post("/api/recordings").send({ url: base + "/login" });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/RECORDER_ENABLED/);
    } finally { process.env.RECORDER_ENABLED = "true"; }
  });

  it("refuses a url that is not http(s)", async () => {
    const res = await request(app).post("/api/recordings").send({ url: "file:///etc/passwd" });
    expect(res.status).toBe(400);
  });

  it("records sign-in, a late card, a placeholder-only field and a same-url wizard — and the steps replay", async () => {
    const start = await request(app).post("/api/recordings").send({ url: base + "/login" });
    expect(start.status).toBe(201);
    const id = start.body.id as string;
    const input = (body: any) => request(app).post(`/api/recordings/${id}/input`).send(body);
    await mirror.goto(base + "/login");

    // Sign in: the real values go to the page only.
    await input({ type: "click", ...(await at("#email")) });
    await input({ type: "type", text: "someone@example.com" });
    await input({ type: "click", ...(await at("#password")) });
    await input({ type: "type", text: "s3cret-Pa55" });
    await input({ type: "click", ...(await at('button[type="submit"]')) });
    await mirror.goto(base + "/create");

    // The frame is a JPEG of the recorded page.
    const frame = await request(app).get(`/api/recordings/${id}/frame`).buffer(true);
    expect(frame.status).toBe(200);
    expect(frame.headers["content-type"]).toBe("image/jpeg");

    // The template card renders late; the recorder clicks it once it is there.
    await mirror.locator("#tc").waitFor();
    await new Promise((r) => setTimeout(r, 700));
    await input({ type: "click", ...(await at("#tc")) });
    await mirror.click("#tc");

    await input({ type: "click", ...(await at("#title")) });
    await input({ type: "type", text: "Jaipur Tech Summit" });
    await mirror.fill("#title", "Jaipur Tech Summit");
    await input({ type: "click", ...(await at("#hyb")) });
    await input({ type: "click", ...(await at("#c1")) });
    await mirror.click("#c1");

    await input({ type: "click", ...(await at("#city")) });
    await input({ type: "type", text: "Jaipur" });
    await input({ type: "click", ...(await at("#pub")) });
    await mirror.fill("#city", "Jaipur");
    await mirror.click("#pub");
    // "Add check": click the confirmation in check mode — an assertion, not a click.
    await input({ type: "click", mode: "check", ...(await at("#out")) });

    const stop = await request(app).post(`/api/recordings/${id}/stop`).send({ title: "Create a hybrid event" });
    expect(stop.status).toBe(200);
    const ir = stop.body.ir;
    const json = JSON.stringify(ir);

    // Credentials: references only, never the typed values.
    expect(json).not.toContain("s3cret-Pa55");
    expect(json).not.toContain("someone@example.com");
    const fills = ir.steps.filter((s: any) => s.action === "fill");
    expect(fills.map((s: any) => s.value)).toEqual(["${env:TEST_USERNAME}", "${env:TEST_PASSWORD}", "Jaipur Tech Summit", "Jaipur"]);

    // Identities are the browser's own: the card by its SPACED accessible name, the title box by its placeholder.
    const card = ir.steps.find((s: any) => s.action === "click" && /Technical Conferences/.test(s.target?.name ?? ""));
    expect(card.target.role).toBe("button");
    expect(card.target.name).toMatch(/^Conference Technical Conferences Tracks/);
    expect(fills[2].target.placeholder).toBe("e.g. Global AI Summit");
    expect(ir.steps.at(-1)).toMatchObject({ action: "assert", assertion: "visible" });
    expect(ir.steps.at(-1).target.text).toMatch(/^Event published: Jaipur Tech Summit in Jaipur/);
    expect(ir.meta.title).toBe("Create a hybrid event");

    // Replay with nothing but the stored steps (the grounding replay's resolver), credentials from env.
    const { resolveLive } = await import("../src/stages/targetResolver.js");
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const env: Record<string, string> = { "${env:TEST_USERNAME}": "someone@example.com", "${env:TEST_PASSWORD}": "s3cret-Pa55" };
    for (const st of ir.steps) {
      if (st.action === "navigate") { await page.goto(st.target.url); continue; }
      if (st.action === "assert") {
        await page.getByText(st.target.text).first().waitFor({ timeout: 5000 });
        continue;
      }
      // The recorded css (#id) is what the generated spec tries first; role+name is the fallback.
      const loc = st.target.css ? page.locator(st.target.css) : await resolveLive(page, st.target, st.action);
      await loc.first().waitFor({ timeout: 5000 });
      if (st.action === "fill") await loc.first().fill(env[st.value] ?? st.value);
      else await loc.first().click();
    }
    expect(await page.locator("#out").textContent()).toBe("Event published: Jaipur Tech Summit in Jaipur");
    await page.close();
  }, 120_000);

  it("a recording belongs to whoever started it: another caller gets 404", async () => {
    const { recordingState, startRecording, closeRecording } = await import("../src/server/recorder.js");
    const { id } = await startRecording("org-a:user-1", base + "/login");
    try {
      expect(() => recordingState(id, "org-b:user-2")).toThrow(/no such recording/);
      expect(recordingState(id, "org-a:user-1").steps).toHaveLength(1);
    } finally { await closeRecording(id); }
  }, 60_000);
});
