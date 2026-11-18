import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildRunReportXlsx, zipFiles } from "../src/stages/xlsxReport.js";

/** Read every entry of a zip back through its central directory (what Excel does). */
function unzip(buf: Buffer): Map<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.set(name, inflateRawSync(buf.subarray(dataStart, dataStart + compSize)).toString("utf8"));
    p += 46 + nameLen;
  }
  return out;
}

describe("Excel report", () => {
  it("zipFiles round-trips through the central directory", () => {
    const files = unzip(zipFiles([{ name: "a.txt", data: "hello" }, { name: "b/c.xml", data: "<x/>" }]));
    expect(files.get("a.txt")).toBe("hello");
    expect(files.get("b/c.xml")).toBe("<x/>");
  });

  it("builds a Summary and a Test Cases sheet with status and no raw markup", () => {
    const buf = buildRunReportXlsx({
      runId: "2026-11-18T02-30-24-478Z-abcdef12",
      prompt: "Replayed 2 saved cases",
      baseUrl: "https://example.test",
      startedAt: Date.parse("2026-11-18T02:30:24.478Z"),
      cases: [
        { caseId: "case-0", title: "Login works", status: "passed", saved: {} },
        { caseId: "case-1", savedCaseId: "11111111-2222-3333-4444-555555555555", title: "Cart <total> & tax", status: "failed", saved: {} },
      ],
    }, { caseLink: (id) => `https://tb.example/#/case/${id}` });
    const parts = unzip(buf);
    expect([...parts.keys()]).toEqual(expect.arrayContaining([
      "[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
    ]));
    expect(parts.get("xl/workbook.xml")).toContain('name="Test Cases"');
    const summary = parts.get("xl/worksheets/sheet1.xml")!;
    expect(summary).toContain("Total test cases");
    expect(summary).toContain("50%");
    const cases = parts.get("xl/worksheets/sheet2.xml")!;
    expect(cases).toContain("Login works");
    expect(cases).toContain("Cart &lt;total&gt; &amp; tax");
    expect(cases).toContain(">PASS<");
    expect(cases).toContain(">FAIL<");
    // QA columns, and a readable id from the title / position.
    for (const h of ["Test Case ID", "Test Scenario / Title", "Preconditions", "Test Steps", "Expected Result",
      "Actual Result", "Status", "Linked Bug ID", "Testbench Link"]) expect(cases).toContain(`>${h}<`);
    expect(cases).toContain(">TC_TEST_001<");
    // The failed test's saved id, as a link that opens it in Testbench.
    expect(cases).toContain(
      'HYPERLINK(&quot;https://tb.example/#/case/11111111-2222-3333-4444-555555555555&quot;,&quot;11111111-2222-3333-4444-555555555555&quot;)');
  });

  it("never writes a password into Test Steps, even one stored as a literal", () => {
    const ir = {
      meta: { title: "Login: works", baseUrl: "https://example.test" },
      steps: [
        { id: "s1", action: "navigate", target: { url: "/login" } },
        { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "${env:TEST_USERNAME}" },
        { id: "s3", action: "fill", target: { role: "textbox", name: "*********" }, value: "hunter2-literal" },
        { id: "s3b", action: "fill", target: { role: "textbox", name: "Login" }, value: "someone@company.example" },
        { id: "s3c", action: "fill", target: { role: "textbox", name: "Password" }, value: "another-literal" },
        { id: "s3d", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "Visible Name" },
        { id: "s4", action: "assert", target: { role: "heading", name: "Dashboard" }, assertion: "visible" },
      ],
    };
    const parts = unzip(buildRunReportXlsx({ runId: "r", cases: [
      { caseId: "case-0", title: "Login: works", status: "passed", saved: {}, ir: ir as any },
    ] }));
    const cases = parts.get("xl/worksheets/sheet2.xml")!;
    expect(cases).not.toContain("hunter2-literal");
    expect(cases).not.toContain("another-literal");
    expect(cases).not.toContain("someone@company.example");
    expect(cases).toContain("(login email hidden)");
    expect(cases).toContain("Visible Name");
    expect(cases).toContain("(password hidden)");
    expect(cases).toContain("(saved username)");
    expect(cases).toContain(">TC_LOGIN_001<");
    expect(cases).toContain("A valid user account exists");
    expect(cases).toContain("&quot;Dashboard&quot; is shown");
  });
});
