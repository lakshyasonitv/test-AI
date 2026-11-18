/**
 * A run's report as an Excel workbook (.xlsx), for handing to developers the way a QA team usually
 * does: a "Summary" sheet (site, run, totals) and a "Test Cases" sheet with one row per test —
 * steps, what was checked, status in green/red, where it failed and the error.
 *
 * Same facts and wording as the PDF: every row comes from `reportRows()` in htmlReport.ts, so the
 * two reports cannot disagree. No new dependency: an .xlsx is a zip of XML parts, and this writes
 * that zip itself (deflate from node:zlib, CRC-32 computed here rather than zlib.crc32, which older
 * Node 20 lines in `engines` do not have).
 */
import { deflateRawSync } from "node:zlib";
import { reportRows, type RunReportInput } from "./htmlReport.js";

// ---------------------------------------------------------------------------------- zip writer

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A plain zip (deflate, no encryption, no zip64) — all an .xlsx needs. */
export function zipFiles(files: { name: string; data: string | Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8");
    const comp = deflateRawSync(raw);
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------------------------------------------------------------------------------- sheet XML

/** XML-escape, drop characters XML 1.0 forbids, and keep within Excel's 32,767-char cell limit. */
const x = (s: unknown): string =>
  String(s ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .slice(0, 32000)
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const colName = (i: number): string => {
  let s = ""; let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

/** Style indexes into styles.xml's cellXfs below. */
const S = { body: 1, header: 2, passed: 3, failed: 4, incomplete: 5, title: 6, label: 7, num: 8, link: 9, linkFailed: 10, todo: 11, actualFailed: 12 } as const;

/** `f`: a formula (used for HYPERLINK); `v` is then its cached text, shown before Excel recalculates. */
type Cell = { v: string | number; s?: number; f?: string };

function sheetXml(rows: Cell[][], widths: number[], opts: { freezeHeader?: boolean; filter?: boolean } = {}): string {
  const lastCol = colName(Math.max(0, widths.length - 1));
  const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => {
    const ref = `${colName(ci)}${ri + 1}`;
    const st = c.s ? ` s="${c.s}"` : "";
    if (c.f) return `<c r="${ref}"${st} t="str"><f>${x(c.f)}</f><v>${x(c.v)}</v></c>`;
    return typeof c.v === "number"
      ? `<c r="${ref}"${st}><v>${c.v}</v></c>`
      : `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${x(c.v)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const pane = opts.freezeHeader
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${body}</sheetData>${opts.filter && rows.length > 1 ? `<autoFilter ref="A1:${lastCol}${rows.length}"/>` : ""}
</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="6">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><name val="Calibri"/></font>
<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font>
<font><b/><u/><sz val="11"/><color rgb="FF9C0006"/><name val="Calibri"/></font>
</fonts>
<fills count="6">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// ---------------------------------------------------------------------------------- workbook


/** The run's report as .xlsx bytes. */
export function buildRunReportXlsx(
  input: RunReportInput,
  /** Turns a saved case id into a link that opens it in Testbench; without it the id is plain text. */
  opts: { caseLink?: (savedCaseId: string) => string } = {},
): Buffer {
  const rows = reportRows(input);
  // QA status words. "blocked" = the site stopped the test (captcha, gate); anything else that
  // did not finish (truncated, no assertion reached) never got to test the app.
  const qa = (r: (typeof rows)[number]): "PASS" | "FAIL" | "BLOCKED" | "NOT EXECUTED" =>
    r.status === "Passed" ? "PASS" : r.status === "Failed" ? "FAIL"
      : r.rawStatus.toLowerCase() === "blocked" ? "BLOCKED" : "NOT EXECUTED";
  const count = (w: string) => rows.filter((r) => qa(r) === w).length;
  const passed = count("PASS");
  const when = input.startedAt && Number.isFinite(input.startedAt)
    ? new Date(input.startedAt).toISOString().replace("T", " ").slice(0, 19) + " UTC"
    : "";
  const statusStyle = (w: string) => (w === "PASS" ? S.passed : w === "FAIL" ? S.failed : S.incomplete);

  const summary: Cell[][] = [
    [{ v: "Test Execution Report", s: S.title }],
    [],
    [{ v: "Application", s: S.label }, { v: input.baseUrl ?? "", s: S.body }],
    [{ v: "Run", s: S.label }, { v: input.prompt ?? "", s: S.body }],
    [{ v: "Run ID", s: S.label }, { v: input.runId, s: S.body }],
    [{ v: "Executed on", s: S.label }, { v: when, s: S.body }],
    [],
    [{ v: "Total test cases", s: S.label }, { v: rows.length, s: S.num }],
    [{ v: "PASS", s: S.passed }, { v: passed, s: S.num }],
    [{ v: "FAIL", s: S.failed }, { v: count("FAIL"), s: S.num }],
    [{ v: "BLOCKED", s: S.incomplete }, { v: count("BLOCKED"), s: S.num }],
    [{ v: "NOT EXECUTED", s: S.incomplete }, { v: count("NOT EXECUTED"), s: S.num }],
    [{ v: "Pass rate", s: S.label }, { v: rows.length ? `${Math.round((passed / rows.length) * 100)}%` : "0%", s: S.num }],
    [],
    [{ v: "PASS: every expected result held. FAIL: a check did not hold, or a step could not be done. BLOCKED: the site stopped the test (e.g. a captcha). NOT EXECUTED: the test could not finish, so it says nothing about the app." }],
  ];

  // TC_<AREA>_<NNN>: AREA from the title's own prefix ("Admin: ...", "Login: ...") or else the
  // case's feature; NNN is its position in this run. Readable, but positional — the Testbench
  // Link column is the id that never changes.
  const area = (r: (typeof rows)[number]): string => {
    const prefix = /^\s*([A-Za-z][A-Za-z0-9 ]{0,20}):/.exec(r.title)?.[1] ?? r.feature ?? "";
    const word = prefix.trim().split(/\s+/)[0] ?? "";
    const up = word.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return up === "AUTHENTICATION" ? "AUTH" : up.slice(0, 10) || "TEST";
  };
  const tcId = (r: (typeof rows)[number], i: number) => `TC_${area(r)}_${String(i + 1).padStart(3, "0")}`;

  const linkCell = (r: (typeof rows)[number]): Cell => {
    if (!r.savedCaseId) return { v: "", s: S.body };
    const failedRow = qa(r) === "FAIL";
    const url = opts.caseLink?.(r.savedCaseId);
    // A failed test's id stands out (red fill) — it is the one a developer is sent to open.
    return url
      ? { v: r.savedCaseId, f: `HYPERLINK("${url.replace(/"/g, '""')}","${r.savedCaseId}")`, s: failedRow ? S.linkFailed : S.link }
      : { v: r.savedCaseId, s: failedRow ? S.failed : S.body };
  };

  const preconditions = (r: (typeof rows)[number]): string => [
    r.startUrl ? `Application reachable at ${r.startUrl}` : input.baseUrl ? `Application reachable at ${input.baseUrl}` : "",
    r.usesLogin ? "A valid user account exists (signed in with the saved login)" : "No sign-in needed",
  ].filter(Boolean).join("\n");

  const actual = (r: (typeof rows)[number]): string => {
    const w = qa(r);
    if (w === "PASS") {
      const n = r.checks.filter((c) => c.state === "held").length;
      return n ? `As expected: all ${n} expected result${n === 1 ? "" : "s"} held` : "All steps completed (this test makes no check of the result)";
    }
    if (w === "FAIL") {
      const failedCheck = r.checks.find((c) => c.state === "failed")?.sentence;
      const what = failedCheck ? `Not as expected: ${failedCheck}` : r.failedAt ? `Could not do ${r.failedAt.replace(/^Step \d+: /, "")}` : "The test failed";
      return [what, r.failedAt ? `(${r.failedAt})` : "", r.error ? `Error: ${r.error}` : ""].filter(Boolean).join("\n");
    }
    return r.summary;
  };

  const header = ["S.No", "Test Case ID", "Test Scenario / Title", "Preconditions", "Test Steps", "Expected Result",
    "Actual Result", "Status", "Linked Bug ID", "Testbench Link", "Duration (s)"];
  const cases: Cell[][] = [
    header.map((h) => ({ v: h, s: S.header })),
    ...rows.map((r, i) => {
      const w = qa(r);
      return [
        { v: i + 1, s: S.num },
        { v: tcId(r, i), s: w === "FAIL" ? S.label : S.body },
        { v: r.title, s: S.body },
        { v: preconditions(r), s: S.body },
        { v: r.actions.map((a, k) => `${k + 1}. ${a}`).join("\n"), s: S.body },
        { v: r.expected.join("\n") || "Every step completes without error", s: S.body },
        { v: actual(r), s: w === "FAIL" ? S.actualFailed : S.body },
        { v: w, s: statusStyle(w) },
        // Left for QA/dev to fill once a defect is logged; a FAIL row's cell is marked as a to-do.
        { v: "", s: w === "FAIL" ? S.todo : S.body },
        linkCell(r),
        { v: r.durationMs ? Math.round(r.durationMs / 100) / 10 : "", s: S.num },
      ];
    }),
  ];

  const ws1 = sheetXml(summary, [22, 80]);
  const ws2 = sheetXml(cases, [7, 18, 38, 34, 55, 45, 50, 14, 16, 38, 12], { freezeHeader: true, filter: true });

  return zipFiles([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Test Cases" sheetId="2" r:id="rId2"/></sheets>
${rows.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">'Test Cases'!$A$1:$K$${rows.length + 1}</definedName></definedNames>` : ""}
</workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: "xl/styles.xml", data: STYLES },
    { name: "xl/worksheets/sheet1.xml", data: ws1 },
    { name: "xl/worksheets/sheet2.xml", data: ws2 },
  ]);
}
