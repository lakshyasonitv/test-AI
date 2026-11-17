import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// D-86 phase 2: Save. The route writes the recording the SERVER holds — never steps from the request —
// through library.saveRecordedCase (mocked here: the real one needs the database), then ends the
// recording. Also: /api/health carries `recorder: true` only with the flag on (platform rule 1).

const saved: any[] = [];
vi.mock("../src/server/library.js", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    saveRecordedCase: vi.fn(async (_u: string, _o: string, _r: string, projectId: string, ir: any, opts: any) => {
      saved.push({ projectId, ir, opts });
      return { id: "case-1", projectId, title: opts.title ?? ir.meta.title, currentVersion: 1 };
    }),
  };
});

let server: http.Server;
let base = "";
let app: any;
let request: any;

beforeAll(async () => {
  server = http.createServer((_q, r) => { r.setHeader("content-type", "text/html"); r.end('<title>t</title><a href="#x" style="display:block;width:200px;height:40px">Go there</a>'); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  process.env.RECORDER_ENABLED = "true";
  ({ app } = await import("../src/server/index.js"));
  request = (await import("supertest")).default;
});

afterAll(async () => {
  delete process.env.RECORDER_ENABLED;
  const { closeAllRecordings } = await import("../src/server/recorder.js");
  await closeAllRecordings();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("Record a test — save and health (phase 2)", () => {
  it("/api/health says recorder: true only while the flag is on", async () => {
    expect((await request(app).get("/api/health")).body.recorder).toBe(true);
    delete process.env.RECORDER_ENABLED;
    try { expect((await request(app).get("/api/health")).body.recorder).toBeUndefined(); }
    finally { process.env.RECORDER_ENABLED = "true"; }
  });

  it("saves the server's own steps (ignoring any sent in the body), then ends the recording", async () => {
    const { id } = (await request(app).post("/api/recordings").send({ url: base })).body;
    await request(app).post(`/api/recordings/${id}/input`).send({ type: "click", x: 50, y: 20 });

    const res = await request(app).post(`/api/recordings/${id}/save`)
      .send({ projectId: "p-1", title: "My flow", steps: [{ id: "s1", action: "navigate", target: { url: "https://evil.example" } }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "case-1", projectId: "p-1", title: "My flow" });

    const { ir, opts } = saved.at(-1);
    expect(opts.title).toBe("My flow");
    expect(JSON.stringify(ir)).not.toContain("evil.example");
    expect(ir.steps.map((s: any) => s.action)).toEqual(["navigate", "click"]);
    expect(ir.steps[1].target).toMatchObject({ role: "link", name: "Go there" });

    // Ended: the recording is gone.
    expect((await request(app).get(`/api/recordings/${id}`)).status).toBe(404);
  }, 60_000);

  it("a save with no project is refused and the recording stays open", async () => {
    const { id } = (await request(app).post("/api/recordings").send({ url: base })).body;
    const res = await request(app).post(`/api/recordings/${id}/save`).send({});
    expect(res.status).toBe(400);
    expect((await request(app).get(`/api/recordings/${id}`)).status).toBe(200);
    await request(app).delete(`/api/recordings/${id}`);
  }, 60_000);
});
