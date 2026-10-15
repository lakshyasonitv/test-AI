import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  checkSpecUpload, claimedFormat, SPEC_WARNINGS, SPEC_BYTE_LIMITS, SPEC_MAX_CHARS,
  specDistillMaxOutputTokens, DEFAULT_SPEC_DISTILL_MAX_OUTPUT_TOKENS,
} from "../src/stages/specIntake.js";

/**
 * Pro intake: every rejection, built from REAL byte prefixes (Pro tests 6 and 7).
 *
 * Each upload is the smallest byte sequence that is genuinely what it claims — a real "%PDF-"
 * header, a real ZIP local-file signature, a real Compound File Binary signature — so these pin
 * the sniffing logic against the formats themselves, not against strings that merely look right.
 * The one valid Word document is a real .docx (`fixtures/proIntake/minimal.docx`) so extraction
 * runs through mammoth for real.
 */

const MB = 1024 * 1024;
const latin1 = (s: string) => Buffer.from(s, "latin1");
const cat = (...parts: (Buffer | string)[]) => Buffer.concat(parts.map((p) => (typeof p === "string" ? latin1(p) : p)));

const PDF_OK = latin1("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const ZIP_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CFB_SIG = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const DOCX_OK = readFileSync(path.join(__dirname, "fixtures", "proIntake", "minimal.docx"));

async function rejected(bytes: Buffer, name: string): Promise<string> {
  const r = await checkSpecUpload(bytes, name);
  if (r.ok) throw new Error(`expected ${name} to be rejected, but it was accepted as ${r.format}`);
  return r.warning;
}

describe("Pro intake accepts the three formats", () => {
  it("accepts a complete, unencrypted PDF without extracting anything", async () => {
    expect(await checkSpecUpload(PDF_OK, "requirements.pdf")).toEqual({ ok: true, format: "pdf" });
  });

  it("accepts a real .docx and extracts its text", async () => {
    const r = await checkSpecUpload(DOCX_OK, "requirements.docx");
    expect(r.ok && r.format === "docx" && r.text).toContain("A Lead cannot convert without a phone number.");
  });

  it("accepts Markdown, stripping a leading BOM", async () => {
    const r = await checkSpecUpload(cat(Buffer.from([0xef, 0xbb, 0xbf]), "# Leads\nA Lead needs a phone."), "spec.md");
    expect(r).toEqual({ ok: true, format: "md", text: "# Leads\nA Lead needs a phone." });
  });

  it("accepts UTF-8 beyond ASCII", async () => {
    const r = await checkSpecUpload(Buffer.from("Thresholds are in ₹ — 10,00,000.", "utf8"), "spec.md");
    expect(r.ok).toBe(true);
  });
});

describe("Pro intake rejects, one test per rejection (test 6)", () => {
  it("oversize PDF — told its size and the limit", async () => {
    const big = cat(PDF_OK, Buffer.alloc(14 * MB - PDF_OK.length, 0x20));
    expect(await rejected(big, "huge.pdf")).toBe("That file is 14 MB. PDFs can be up to 10 MB.");
  });

  it("oversize Markdown — held to its own 2 MB limit, not the PDF one", async () => {
    const big = Buffer.alloc(SPEC_BYTE_LIMITS.md + 1, 0x61);
    expect(await rejected(big, "huge.md")).toBe(SPEC_WARNINGS.tooBig("md", SPEC_BYTE_LIMITS.md + 1));
    expect(await rejected(big, "huge.md")).toMatch(/Markdown files can be up to 2 MB\.$/);
  });

  it("an .xlsx renamed .docx — a ZIP with no word/document.xml", async () => {
    const xlsx = cat(ZIP_SIG, "\x14\x00\x06\x00\x08\x00", "xl/workbook.xml", Buffer.alloc(64));
    expect(await rejected(xlsx, "budget.docx")).toBe("That's a ZIP file, not a Word document.");
  });

  it("a binary file renamed .md", async () => {
    const bin = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00, 0xff, 0xfe]);
    expect(await rejected(bin, "notes.md")).toBe("That file isn't readable as text.");
  });

  it("invalid UTF-8 with no NUL byte is still rejected — the decoder's throw IS the rejection", async () => {
    expect(await rejected(Buffer.from([0x41, 0xc3, 0x28, 0x42]), "notes.md")).toBe("That file isn't readable as text.");
  });

  it("an old binary .doc gets its OWN message, named .doc or .docx", async () => {
    const doc = cat(CFB_SIG, Buffer.alloc(504));
    const msg = "That's an older .doc file. Open it in Word and save as .docx.";
    expect(await rejected(doc, "old.doc")).toBe(msg);
    expect(await rejected(doc, "old.docx")).toBe(msg);
  });

  it("a password-protected .docx (a CFB container with an EncryptedPackage stream) is NOT called an old .doc", async () => {
    const enc = cat(CFB_SIG, Buffer.alloc(120), Buffer.from("EncryptedPackage", "utf16le"), Buffer.alloc(64));
    expect(await rejected(enc, "locked.docx")).toBe("That Word document is password-protected and can't be read.");
  });

  it("a macro-enabled document — by extension, and when renamed .docx", async () => {
    expect(await rejected(DOCX_OK, "macros.docm")).toBe(SPEC_WARNINGS.macroDocx);
    const renamed = cat(ZIP_SIG, "word/document.xml", Buffer.alloc(16), "word/vbaProject.bin");
    expect(await rejected(renamed, "macros.docx")).toBe(SPEC_WARNINGS.macroDocx);
  });

  it("an encrypted PDF", async () => {
    const enc = latin1("%PDF-1.7\ntrailer << /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF\n");
    expect(await rejected(enc, "locked.pdf")).toBe("That PDF is password-protected and can't be read.");
  });

  it("a truncated PDF — no %%EOF in the last 1 KB", async () => {
    const cut = cat("%PDF-1.7\n", Buffer.alloc(4096, 0x20));
    expect(await rejected(cut, "cut.pdf")).toBe("That PDF looks incomplete — the upload may have been cut off.");
  });

  it("an empty file, in every format", async () => {
    for (const name of ["a.pdf", "a.docx", "a.md"]) {
      expect(await rejected(Buffer.alloc(0), name)).toBe("That file is empty.");
    }
  });

  it("a whitespace-only Markdown file is empty", async () => {
    expect(await rejected(latin1("  \n\t\n"), "a.md")).toBe("That file is empty.");
  });

  it("a 200,000-character Markdown file", async () => {
    const md = Buffer.alloc(200_000, 0x61);
    expect(await rejected(md, "long.md")).toBe("That Markdown file is 200,000 characters. The limit is 150,000.");
  });

  it("a Markdown file over a million characters is phrased in millions", async () => {
    expect(SPEC_WARNINGS.tooManyChars("md", 1_200_000)).toBe("That Markdown file is 1.2 million characters. The limit is 150,000.");
  });

  it("exactly the character limit is accepted", async () => {
    expect((await checkSpecUpload(Buffer.alloc(SPEC_MAX_CHARS, 0x61), "edge.md")).ok).toBe(true);
  });

  it("an unsupported extension", async () => {
    expect(await rejected(PDF_OK, "spec.xlsx")).toBe(SPEC_WARNINGS.unsupported);
    expect(await rejected(PDF_OK, "spec")).toBe(SPEC_WARNINGS.unsupported);
  });
});

describe("extension and magic bytes disagreeing is rejected, not resolved (test 7)", () => {
  it("a PDF named .docx", async () => {
    expect(await rejected(PDF_OK, "spec.docx")).toBe("That file is named as a Word document, but it's actually a PDF.");
  });

  it("a Word document named .pdf", async () => {
    expect(await rejected(DOCX_OK, "spec.pdf")).toBe("That file is named as a PDF, but it's actually a ZIP archive.");
  });

  it("a PDF named .md — the text format does not get to 'decode' a binary", async () => {
    expect(await rejected(PDF_OK, "spec.md")).toBe("That file is named as a Markdown file, but it's actually a PDF.");
  });

  it("plain text named .pdf", async () => {
    expect(await rejected(latin1("A Lead needs a phone number.\n%%EOF"), "spec.pdf"))
      .toBe("That file is named as a PDF, but its contents aren't one.");
  });

  it("the %PDF- signature counts only at offset 0", async () => {
    expect(await rejected(cat(" ", PDF_OK), "spec.pdf")).toBe("That file is named as a PDF, but its contents aren't one.");
  });

  it("neither side is guessed: the same bytes pass only under their true extension", async () => {
    expect((await checkSpecUpload(PDF_OK, "x.pdf")).ok).toBe(true);
    for (const n of ["x.docx", "x.md", "x.txt"]) expect((await checkSpecUpload(PDF_OK, n)).ok).toBe(false);
  });
});

describe("claimedFormat", () => {
  it("is case-insensitive and reads only the last extension", () => {
    expect(claimedFormat("Requirements.V2.PDF")).toBe("pdf");
    expect(claimedFormat("spec.pdf.docx")).toBe("docx");
    expect(claimedFormat("README.markdown")).toBe("md");
  });
});

describe("the distillation output cap (configured, stage 2 uses it)", () => {
  it("defaults to 8192 and honours a valid override only", () => {
    const saved = process.env.SPEC_DISTILL_MAX_OUTPUT_TOKENS;
    try {
      delete process.env.SPEC_DISTILL_MAX_OUTPUT_TOKENS;
      expect(specDistillMaxOutputTokens()).toBe(8192);
      expect(DEFAULT_SPEC_DISTILL_MAX_OUTPUT_TOKENS).toBe(8192);
      process.env.SPEC_DISTILL_MAX_OUTPUT_TOKENS = "16384";
      expect(specDistillMaxOutputTokens()).toBe(16384);
      for (const bad of ["0", "-5", "lots", ""]) {
        process.env.SPEC_DISTILL_MAX_OUTPUT_TOKENS = bad;
        expect(specDistillMaxOutputTokens()).toBe(8192);
      }
    } finally {
      if (saved === undefined) delete process.env.SPEC_DISTILL_MAX_OUTPUT_TOKENS;
      else process.env.SPEC_DISTILL_MAX_OUTPUT_TOKENS = saved;
    }
  });
});
