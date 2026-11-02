import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { generateSpec, rememberLocatorCode } from "../src/stages/generator.js";
import { runSpec } from "../src/stages/executor.js";
import type { IR } from "../src/schema/ir.js";

/**
 * D-73 step 1B, run for real (D-19): with REGRESSION_MEMORY_ENABLED on, the generated spec records
 * what each element looked like just before its step acted, into artifacts/elements.json.
 *
 * The page copies how a real Lightning Account form nests a field (seen in a captured form): a
 * wrapper `div[data-target-selection-name="sfdc:RecordField.Account.Name"]` inside one component's
 * shadow root, a `<slot>` in it, and the actual `<input>` inside ANOTHER component's shadow root that
 * is slotted there. Reaching the wrapper from the input needs shadow hosts AND assignedSlot.
 */

const PAGE = `<!doctype html><html><head><title>Zq form</title></head><body><main>
<zq-item><zq-input slot="inputField"></zq-input></zq-item>
<button class="go">Go</button><button class="go" hidden>Go</button>
<p id="out"></p>
<script>
customElements.define("zq-item", class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: "open" }).innerHTML =
    '<div data-target-selection-name="sfdc:RecordField.Account.Name" role="listitem"><span><slot name="inputField"></slot></span></div>'; } });
customElements.define("zq-input", class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: "open" }).innerHTML = '<label for="i1">Account Name</label><input id="i1" type="text">'; } });
document.querySelector(".go").onclick = () => {
  const v = document.querySelector("zq-input").shadowRoot.querySelector("input").value;
  document.getElementById("out").textContent = "Saved " + v;
};
</script></main></body></html>`;

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/lightning/o/Account/new")) res.end(PAGE); else { res.statusCode = 404; res.end(""); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
afterEach(() => { delete process.env.REGRESSION_MEMORY_ENABLED; });

const irFor = (baseUrl: string): IR => ({
  meta: { feature: "f", title: "Create a Zq account", priority: "high", sourcePrompt: "p", baseUrl },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/lightning/o/Account/new?count=1" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Account Name", css: "#i1" }, value: "Northwind" },
    { id: "s3", action: "click", target: { role: "button", name: "Go", css: ".go" } },
    { id: "s4", action: "assert", target: { text: "Saved Northwind" }, assertion: "visible" },
  ],
} as unknown as IR);

describe("step 1B: the generated spec records element details", () => {
  it("off: the spec has no trace of it (nothing emitted, no helper)", () => {
    const spec = generateSpec(irFor("https://zq.example"), "artifacts");
    expect(spec).not.toContain("remember(");
    expect(spec).not.toContain("REMEMBERED");
  });

  it("on: each element step is remembered before it acts; navigate and assert are not", () => {
    process.env.REGRESSION_MEMORY_ENABLED = "true";
    const spec = generateSpec(irFor("https://zq.example"), "artifacts");
    expect(spec).toContain(`await remember(page, page.locator("#i1"), "s2", "artifacts/elements.json");`);
    expect(spec).toContain(`await remember(page, page.locator(".go"), "s3", "artifacts/elements.json");`);
    expect(spec.match(/await remember\(/g)?.length).toBe(2);
  });

  it("counts every match, never .first(), and covers each kind of target", () => {
    const step = (target: any) => ({ id: "x", action: "click", target }) as any;
    expect(rememberLocatorCode(step({ css: "a.b" }))).toBe(`page.locator("a.b")`);
    expect(rememberLocatorCode(step({ role: "button", name: "Save" }))).toBe(`page.getByRole("button", { name: "Save", exact: true })`);
    expect(rememberLocatorCode(step({ label: "Email" }))).toBe(`page.getByLabel("Email", { exact: true })`);
    expect(rememberLocatorCode({ id: "x", action: "assert", target: { text: "Hi" } } as any)).toBeNull();
    expect(rememberLocatorCode(step({ css: "#f", frame: "iframe#a" }))).toBe(`page.frameLocator("iframe#a").locator("#f")`);
  });

  // Playwright only finds specs under ./runs (playwright.config.ts testDir): a short-lived folder there.
  const runDir = path.join("runs", `0000-regression-elements-${process.pid}-${Date.now()}`);
  afterAll(() => rmSync(runDir, { recursive: true, force: true }));

  it("in real Chromium: the case still passes, and elements.json holds the field binding and the match count", async () => {
    process.env.REGRESSION_MEMORY_ENABLED = "true";
    mkdirSync(runDir, { recursive: true });
    const artifacts = path.join(runDir, "artifacts");
    const result = await runSpec(generateSpec(irFor(base), artifacts), runDir, {});
    expect(result.passed).toBe(true);
    const file = path.join(artifacts, "elements.json");
    expect(existsSync(file)).toBe(true);
    const seen = JSON.parse(readFileSync(file, "utf8"));
    expect(seen.s2).toMatchObject({ path: "/lightning/o/Account/new", matches: 1, tag: "input", type: "text", name: "Account Name", sfField: "Account.Name" });
    expect(seen.s3).toMatchObject({ matches: 2, tag: "button", name: "Go", sfField: null });
    expect(JSON.stringify(seen)).not.toContain("Northwind");   // never a typed value
    expect(Object.keys(seen).sort()).toEqual(["s2", "s3"]);
  }, 240_000);
});
