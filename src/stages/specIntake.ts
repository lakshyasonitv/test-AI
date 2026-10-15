import mammoth from "mammoth";
import { createHash } from "node:crypto";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import { currentLlmConfig, resolvedModel } from "../llm/llmContext.js";
import { llmCacheGet, llmCacheSet, makeCacheKey, isCacheableResult, llmCacheVersion } from "../kb/llmCache.js";
import { LlmSpecModel, isEmptySpec, type SpecModel } from "../schema/spec.js";
import { z } from "zod";
import { llm, cacheModelDimension } from "../llm/client.js";
import { llmCacheDimension } from "../llm/llmContext.js";
import type { AppModel } from "../schema/appModel.js";

/**
 * Pro mode, phase A: accept ONE requirements document and decide whether it can be read.
 *
 * This file owns the deterministic half of intake — size limits, format sniffing, structural
 * checks and text extraction. Every rejection is one short plain sentence for the warnings panel,
 * never an error code. The checks run cheapest first and stop at the first failure:
 *
 *   1. byte length          (by the claimed extension's limit)
 *   2. magic bytes          (decides the real format)
 *   3. extension vs sniff   (a disagreement is a REJECTION — never guess which one is right)
 *   4. structural check     (per format)
 *   5. extraction           (DOCX and Markdown only — PDFs are never parsed on our side)
 *   6. character length     (DOCX and Markdown only)
 *
 * The browser's MIME type is never consulted: it is the client's claim, browsers disagree about
 * `.md` entirely, and the bytes are the only thing that cannot lie about what they are.
 *
 * NOTHING HERE WRITES TO DISK. The bytes arrive in memory and leave in memory; the caller drops
 * them once distillation returns. `runs/` is served over HTTP (TD-14), so a document stored there
 * would be fetchable by anyone holding the run id.
 */

export type SpecFormat = "pdf" | "docx" | "md";

const MB = 1024 * 1024;

/** Byte limits per format. Exported so the browser's pre-upload check can mirror them exactly. */
export const SPEC_BYTE_LIMITS: Record<SpecFormat, number> = {
  pdf: 10 * MB,
  docx: 10 * MB,
  md: 2 * MB,
};

/**
 * Extracted-text ceiling for DOCX and Markdown.
 *
 * 150,000, not 200,000: `gemini()` refuses any prompt over LLM_MAX_PROMPT_CHARS (200,000 by
 * default, `src/llm/gemini.ts`), and the distillation prompt also carries its own instructions
 * and schema. The remaining 50,000 is that headroom. PDFs are not counted by that guard at all —
 * it measures `prompt.length` before the inline file part is attached — which is exactly why PDFs
 * get their own byte limit above instead.
 */
export const SPEC_MAX_CHARS = 150_000;

/**
 * Output-token ceiling for the distillation call (stage 2).
 *
 * 8192, not 4096: on Gemini's thinking models the model's internal reasoning tokens count against
 * `maxOutputTokens`, so a 4096 cap can be spent on reasoning and cut the JSON answer off mid-way.
 * Applies to the distillation call ONLY — the shared `gemini()` default is untouched, so no
 * existing call changes. Override with SPEC_DISTILL_MAX_OUTPUT_TOKENS.
 */
export const DEFAULT_SPEC_DISTILL_MAX_OUTPUT_TOKENS = 8192;
export function specDistillMaxOutputTokens(): number {
  const raw = Number(process.env.SPEC_DISTILL_MAX_OUTPUT_TOKENS ?? DEFAULT_SPEC_DISTILL_MAX_OUTPUT_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SPEC_DISTILL_MAX_OUTPUT_TOKENS;
}

/** The result of checking one upload: a readable document, or the one sentence explaining why not. */
export type SpecUploadCheck =
  | { ok: true; format: "pdf" }
  | { ok: true; format: "docx" | "md"; text: string }
  | { ok: false; warning: string };

// --------------------------------------------------------------------------------------------
// The sentences. One place, so the panel's wording cannot drift between call sites.
// --------------------------------------------------------------------------------------------

const FORMAT_NOUN: Record<SpecFormat, string> = {
  pdf: "PDFs",
  docx: "Word documents",
  md: "Markdown files",
};

const FORMAT_LABEL: Record<SpecFormat, string> = {
  pdf: "PDF",
  docx: "Word document",
  md: "Markdown file",
};

/** "14 MB", "10.5 MB", "0.3 MB" — whole numbers stay whole. */
function formatMb(bytes: number): string {
  const mb = Math.round((bytes / MB) * 10) / 10;
  return `${mb} MB`;
}

/** "1.2 million", "200,000". */
function formatChars(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10} million`;
  return n.toLocaleString("en-US");
}

export const SPEC_WARNINGS = {
  tooBig: (format: SpecFormat, bytes: number) =>
    `That file is ${formatMb(bytes)}. ${FORMAT_NOUN[format]} can be up to ${formatMb(SPEC_BYTE_LIMITS[format])}.`,
  tooManyChars: (format: "docx" | "md", chars: number) =>
    `That ${FORMAT_LABEL[format]} is ${formatChars(chars)} characters. The limit is ${formatChars(SPEC_MAX_CHARS)}.`,
  zipNotDocx: "That's a ZIP file, not a Word document.",
  oldDoc: "That's an older .doc file. Open it in Word and save as .docx.",
  encryptedPdf: "That PDF is password-protected and can't be read.",
  truncatedPdf: "That PDF looks incomplete — the upload may have been cut off.",
  notText: "That file isn't readable as text.",
  empty: "That file is empty.",
  noText: "No text found in this document — it may be a scan.",
  replaced: (from: string, to: string) => `Replaced "${from}" with "${to}".`,
  // Not in the original wording list — each one covers a case the list did not name.
  encryptedDocx: "That Word document is password-protected and can't be read.",
  macroDocx: "That's a macro-enabled Word file. Save it as a plain .docx and upload that.",
  unsupported: "That file type isn't supported. Upload a PDF, a Word document (.docx) or a Markdown file.",
  mismatch: (claimed: SpecFormat, actual: string) =>
    `That file is named as a ${FORMAT_LABEL[claimed]}, but it's actually ${actual}.`,
  notWhatItSays: (claimed: SpecFormat) =>
    `That file is named as a ${FORMAT_LABEL[claimed]}, but its contents aren't one.`,
} as const;

// --------------------------------------------------------------------------------------------
// Sniffing
// --------------------------------------------------------------------------------------------

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** Compound File Binary — the container of an old binary .doc, AND of an encrypted .docx. */
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

type Sniffed = "pdf" | "zip" | "cfb" | "other";

function startsWith(bytes: Buffer, magic: Buffer): boolean {
  return bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic);
}

function sniff(bytes: Buffer): Sniffed {
  if (startsWith(bytes, PDF_MAGIC)) return "pdf";
  if (startsWith(bytes, ZIP_MAGIC)) return "zip";
  if (startsWith(bytes, CFB_MAGIC)) return "cfb";
  return "other";
}

const SNIFFED_NOUN: Record<Exclude<Sniffed, "other">, string> = {
  pdf: "a PDF",
  zip: "a ZIP archive",
  cfb: "an older Office file",
};

/** The format the filename claims, or null for anything we do not accept. */
export function claimedFormat(filename: string): SpecFormat | "doc" | "docm" | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case "pdf": return "pdf";
    case "docx": return "docx";
    case "md": case "markdown": case "txt": return "md";
    case "doc": return "doc";
    case "docm": return "docm";
    default: return null;
  }
}

const has = (bytes: Buffer, needle: string, encoding: BufferEncoding = "latin1") =>
  bytes.indexOf(Buffer.from(needle, encoding)) !== -1;

// --------------------------------------------------------------------------------------------
// The check
// --------------------------------------------------------------------------------------------

/**
 * Check one upload. Pure apart from DOCX extraction (mammoth, in memory). Never throws for a bad
 * document — every failure is a `{ ok: false, warning }` with the sentence to show.
 */
export async function checkSpecUpload(bytes: Buffer, filename: string): Promise<SpecUploadCheck> {
  const claimed = claimedFormat(filename);
  if (bytes.length === 0) return { ok: false, warning: SPEC_WARNINGS.empty };

  // Rejected by name before anything else: neither is a format we read, and both have a message
  // more useful than "unsupported".
  if (claimed === "docm") return { ok: false, warning: SPEC_WARNINGS.macroDocx };
  if (claimed === null) return { ok: false, warning: SPEC_WARNINGS.unsupported };

  // 1. Byte length, by the claimed format's limit. A ".doc" is held to the Word limit so a huge
  //    one is still told its size rather than told to re-save it.
  const limitFormat: SpecFormat = claimed === "doc" ? "docx" : claimed;
  if (bytes.length > SPEC_BYTE_LIMITS[limitFormat]) {
    return { ok: false, warning: SPEC_WARNINGS.tooBig(limitFormat, bytes.length) };
  }

  // 2. Magic bytes decide what the file really is.
  const actual = sniff(bytes);

  // A CFB container named .doc or .docx is either an encrypted .docx (Word wraps those in CFB,
  // with an "EncryptedPackage" stream whose name is stored UTF-16LE) or a genuine old .doc.
  // Told apart by that stream name — structure, not a guess.
  if (actual === "cfb" && (claimed === "doc" || claimed === "docx")) {
    return {
      ok: false,
      warning: has(bytes, "EncryptedPackage", "utf16le") ? SPEC_WARNINGS.encryptedDocx : SPEC_WARNINGS.oldDoc,
    };
  }
  if (claimed === "doc") {
    // Named .doc but not a CFB file: whatever it is, it is not something we read.
    return { ok: false, warning: actual === "other" ? SPEC_WARNINGS.notWhatItSays("docx") : SPEC_WARNINGS.mismatch("docx", SNIFFED_NOUN[actual]) };
  }

  // 3. Extension vs sniff. A disagreement is rejected, never resolved.
  const expected: Record<SpecFormat, Sniffed> = { pdf: "pdf", docx: "zip", md: "other" };
  if (actual !== expected[claimed]) {
    return {
      ok: false,
      warning: actual === "other" ? SPEC_WARNINGS.notWhatItSays(claimed) : SPEC_WARNINGS.mismatch(claimed, SNIFFED_NOUN[actual]),
    };
  }

  // 4–6, per format.
  switch (claimed) {
    case "pdf": return checkPdf(bytes);
    case "docx": return checkDocx(bytes);
    case "md": return checkMarkdown(bytes);
  }
}

function checkPdf(bytes: Buffer): SpecUploadCheck {
  // A complete PDF ends with %%EOF (allowing trailing whitespace or a short tail). Missing from
  // the last 1 KB means the upload was cut off.
  if (!has(bytes.subarray(Math.max(0, bytes.length - 1024)), "%%EOF")) {
    return { ok: false, warning: SPEC_WARNINGS.truncatedPdf };
  }
  // An encryption dictionary means the model would be handed ciphertext.
  if (has(bytes, "/Encrypt")) return { ok: false, warning: SPEC_WARNINGS.encryptedPdf };
  // No extraction: the raw bytes go to the model as an inline file.
  return { ok: true, format: "pdf" };
}

async function checkDocx(bytes: Buffer): Promise<SpecUploadCheck> {
  // ZIP stores entry names uncompressed, so these need no unzip. `word/document.xml` is what makes
  // a ZIP a Word document rather than a workbook, a deck or an arbitrary archive.
  if (!has(bytes, "word/document.xml")) return { ok: false, warning: SPEC_WARNINGS.zipNotDocx };
  // A macro-enabled document renamed to .docx still carries its VBA project.
  if (has(bytes, "word/vbaProject.bin")) return { ok: false, warning: SPEC_WARNINGS.macroDocx };

  let text: string;
  try {
    text = (await mammoth.extractRawText({ buffer: bytes })).value;
  } catch {
    return { ok: false, warning: SPEC_WARNINGS.notText };
  }
  return checkText("docx", text);
}

function checkMarkdown(bytes: Buffer): SpecUploadCheck {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  // A NUL byte in the first 8 KB is binary, whatever it decodes as.
  if (body.subarray(0, 8192).includes(0x00)) return { ok: false, warning: SPEC_WARNINGS.notText };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return { ok: false, warning: SPEC_WARNINGS.notText };
  }
  if (!text.trim()) return { ok: false, warning: SPEC_WARNINGS.empty };
  return checkText("md", text);
}

function checkText(format: "docx" | "md", text: string): SpecUploadCheck {
  if (!text.trim()) return { ok: false, warning: format === "docx" ? SPEC_WARNINGS.noText : SPEC_WARNINGS.empty };
  if (text.length > SPEC_MAX_CHARS) return { ok: false, warning: SPEC_WARNINGS.tooManyChars(format, text.length) };
  return { ok: true, format, text };
}

// ============================================================================================
// Distillation — ONE Gemini call, cached on the document's own bytes
// ============================================================================================

/**
 * The distillation instructions.
 *
 * Their exact TEXT is part of the cache key (`DECISIONS.md` D-10), so editing a word here makes
 * every document distil afresh on its next upload — nobody has to remember to bump a version, and
 * an edited prompt can never keep serving answers the old one produced.
 */
export const SPEC_DISTILL_SYSTEM = `You read ONE software requirements document and distil it into a structured specification that a QA engineer will use to decide which test cases to write. Output ONLY a JSON object, no prose, no markdown fences.

Fields — every field is an array of short, plain-English strings:
- "actors": the kinds of user or system that act (e.g. "Sales Manager", "Guest").
- "entities": the business objects the document talks about (e.g. "Lead", "Account").
- "actions": what the actors do to those entities (e.g. "Convert a Lead to an Account").
- "rules": TESTABLE constraints — each one a single sentence a tester could prove true or false
  against the running application (e.g. "A Lead cannot be converted without a phone number").
- "criteria": acceptance criteria the document states (e.g. "Converting shows a confirmation naming the new Account").
- "outOfScope": anything the document explicitly excludes or defers.
- "unresolved": questions a tester would need answered before testing, where the document is
  ambiguous, contradictory or silent on something it clearly depends on. AT MOST 10, most
  important first. If nothing is genuinely unclear, return an empty array — do not invent questions.

Rules, follow exactly:
- Take everything from the document. Never add a rule, actor or criterion the document does not support.
- Keep each string under 300 characters. One idea per string.
- Do not copy passwords, API keys, personal data or other secrets from the document into any field.
- If the document contains no readable requirements text (for example it is a scanned image), return every field as an empty array.

Shape: { "actors": [], "entities": [], "actions": [], "rules": [], "criteria": [], "outOfScope": [], "unresolved": [] }`;

/** A distillation outcome: the spec, or the one sentence explaining why there isn't one. */
export type SpecDistillResult =
  | { ok: true; spec: SpecModel; cached: boolean }
  | { ok: false; warning: string };

/** Shown when the model's answer could not be used even after a retry. */
export const DISTILL_FAILED_WARNING = "That document couldn't be summarised just now. Try uploading it again.";

/**
 * Distil one ALREADY-CHECKED document (the output of `checkSpecUpload`) into a SpecModel.
 *
 * Cache first: the key is the document's own SHA-256 plus every input that changes the answer —
 * the pinned provider, the resolved model, the instruction text, the credential fingerprint and
 * the global cache salt. The disk half of the cache never expires (`kb/llmCache.ts`), so a missing
 * dimension would serve a wrong answer forever (TD-22, D-10). Entries live in their own "spec"
 * namespace so they can be cleared without discarding the paid answers beside them.
 *
 * Pinned to GEMINI regardless of LLM_PROVIDER: only Gemini takes a PDF inline. Called from the
 * upload route, outside any run, so no run budget covers it — the token usage is logged instead.
 *
 * The bytes are only read here. Nothing in this function stores them: the caller drops its
 * reference when this returns, and the only thing written anywhere is the distilled SpecModel.
 */
export async function distillSpec(
  bytes: Buffer,
  checked: Extract<SpecUploadCheck, { ok: true }>,
): Promise<SpecDistillResult> {
  const model = resolvedModel();
  const key = makeCacheKey(
    "specmodel", "gemini", model, SPEC_DISTILL_SYSTEM,
    createHash("sha256").update(bytes).digest("hex"),
    `gemini:${currentLlmConfig()?.keyFingerprint ?? "env"}`, llmCacheVersion(),
  );
  const hit = llmCacheGet<SpecModel>(key, SPEC_CACHE_NS);
  if (hit) return { ok: true, spec: hit, cached: true };

  const prompt = checked.format === "pdf"
    ? "The requirements document is attached as a PDF. Distil it."
    : `The requirements document follows between the markers. Distil it.\n<<<DOCUMENT\n${checked.text}\nDOCUMENT>>>`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, usage } = await gemini(prompt, {
      systemInstruction: SPEC_DISTILL_SYSTEM,
      ...(checked.format === "pdf"
        ? { fileBase64: bytes.toString("base64"), fileMime: "application/pdf" }
        : {}),
      model,
      json: true,
      maxOutputTokens: specDistillMaxOutputTokens(),
      stage: "spec_intake",
    });
    // Outside any run budget, so this line is the only record of what intake cost.
    console.log(`[spec_intake] distillation tokens: prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${usage.totalTokens} | format=${checked.format} | model=${model}`);

    let parsed: ReturnType<typeof LlmSpecModel.safeParse>;
    try {
      parsed = LlmSpecModel.safeParse(parseJson(content));
    } catch {
      continue;
    }
    if (!parsed.success) continue;

    const spec = parsed.data;
    // "Found nothing" is an answer about THIS document (usually a scan), not a cacheable result —
    // an empty answer served forever is exactly the failure isCacheableResult exists to stop.
    if (isEmptySpec(spec)) return { ok: false, warning: SPEC_WARNINGS.noText };
    if (isCacheableResult(spec)) llmCacheSet(key, spec, SPEC_CACHE_NS);
    return { ok: true, spec, cached: false };
  }
  return { ok: false, warning: DISTILL_FAILED_WARNING };
}

/** The cache namespace for distilled specs — clearable on its own (`llmCacheClear("spec")`). */
export const SPEC_CACHE_NS = "spec";

// ============================================================================================
// The flag, and the run's comparison warnings (in memory only)
// ============================================================================================

/**
 * Whether this server offers Pro document intake. SPEC_INTAKE_ENABLED, default OFF, registered in
 * BOOLEAN_ENV_FLAGS (server/index.ts) so a malformed value refuses to boot.
 *
 * The routes are mounted whether or not this is on and check it INSIDE the handler (403 when
 * off): a route that exists only when a flag is set would make the route-table guards in
 * tests/multiTenancy.test.ts and tests/tenancy.test.ts depend on the environment they run in, and
 * flag-off must run flag-on's code path rather than skip it (CLAUDE.md rule 7).
 */
export function specIntakeEnabled(): boolean {
  return process.env.SPEC_INTAKE_ENABLED === "true";
}

/** One run's comparison warnings, and whether the comparison has finished (successfully or not). */
export interface RunSpecWarnings {
  warnings: string[];
  done: boolean;
}

/**
 * Comparison warnings, held IN MEMORY beside the run — never written to runs/.
 *
 * The warnings describe the uploaded document, and runs/ is served over HTTP (TD-14). A file there
 * would publish what intake deliberately discarded. Accepted consequence: they vanish when the
 * container sleeps (`minReplicas: 0`), so a past run shows none. See DECISIONS.md before adding
 * persistence — the safe form phrases warnings without quoting the document.
 *
 * Bounded so a long-lived process cannot grow it without limit: the oldest run is evicted first.
 */
const MAX_RUNS_WITH_WARNINGS = 200;
const runWarnings = new Map<string, RunSpecWarnings>();

export function setRunSpecWarnings(runId: string, value: RunSpecWarnings): void {
  runWarnings.delete(runId);
  runWarnings.set(runId, { warnings: [...value.warnings], done: value.done });
  while (runWarnings.size > MAX_RUNS_WITH_WARNINGS) {
    const oldest = runWarnings.keys().next().value;
    if (oldest === undefined) break;
    runWarnings.delete(oldest);
  }
}

/** A run's warnings; `{ warnings: [], done: false }` for a run that has recorded none. */
export function getRunSpecWarnings(runId: string): RunSpecWarnings {
  const v = runWarnings.get(runId);
  return v ? { warnings: [...v.warnings], done: v.done } : { warnings: [], done: false };
}

// ============================================================================================
// Spec vs. application comparison — informational warnings for the run's side panel
// ============================================================================================

/** At most this many comparison warnings per run, each at most this long. */
const MAX_COMPARE_WARNINGS = 20;
const MAX_WARNING_CHARS = 240;

/**
 * The comparison instructions. Their text is part of the cache key (D-10).
 *
 * Every warning must point at something that EXISTS — a rule by its number, a page by its URL —
 * and the code below drops any that does not. The model's claim is a preference; the reference
 * check is the constraint (CLAUDE.md's central design rule).
 */
export const SPEC_COMPARE_SYSTEM = `You compare a requirements specification with a model of a real web application that a crawler discovered, and report gaps a QA lead should know about before testing. Output ONLY a JSON object, no prose, no markdown fences.

Report only two kinds of gap:
1. "untestable_rule": a numbered rule that nothing in the application model can exercise — no page, field or control it would need. Give its "rule" number.
2. "unmentioned": a page of the application that the specification never mentions at all. Give the page's "url" exactly as it appears in the application model.

For each gap write "message": ONE short plain-English sentence (under 200 characters) for a non-technical reader. Describe the gap in your own words — do NOT quote the rule's text, e.g. "A rule about the Lead's phone number can't be tested — no phone field was found."
Report nothing you are unsure of. No gaps is a valid answer.

Shape: { "gaps": [ { "kind": "untestable_rule", "rule": 1, "message": "..." }, { "kind": "unmentioned", "url": "https://...", "message": "..." } ] }`;

const CompareGap = z.object({
  kind: z.enum(["untestable_rule", "unmentioned"]),
  rule: z.number().int().optional(),
  url: z.string().optional(),
  message: z.string(),
});

/** What the comparison sees of the app: page URL, concepts, and each element's role + name. */
function compareProjection(appModel: AppModel) {
  return appModel.pages.map((p) => ({
    url: p.url,
    concepts: p.concepts,
    elements: p.elements.slice(0, 150).map((e) => `${e.role}: ${e.name}`),
  }));
}

/**
 * Ask the lite model where the spec and the discovered application disagree. Returns plain
 * sentences. THROWS on any provider failure — `runSpecComparison` is the never-throwing wrapper.
 *
 * Runs through `llm()` with role "lite", so it follows LLM_PROVIDER like the rest of the run (no
 * PDF here, so no reason to pin it to Gemini). The lite role never sends `reasoning_effort`
 * (llmContext.ts) — the lite Azure deployment rejects it.
 */
export async function compareSpecToApp(spec: SpecModel, appModel: AppModel): Promise<string[]> {
  if (spec.rules.length === 0 && spec.criteria.length === 0) return [];
  const projection = compareProjection(appModel);
  const key = makeCacheKey(
    "speccompare", JSON.stringify(spec), JSON.stringify(projection), SPEC_COMPARE_SYSTEM,
    cacheModelDimension("lite"), llmCacheDimension("lite"), llmCacheVersion(),
  );
  const hit = llmCacheGet<string[]>(key, SPEC_CACHE_NS);
  if (hit) return hit;

  const numbered = spec.rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const prompt =
    `Rules (numbered):\n${numbered || "(none)"}\n\n` +
    (spec.criteria.length ? `Acceptance criteria:\n${spec.criteria.map((c) => `- ${c}`).join("\n")}\n\n` : "") +
    (spec.outOfScope.length ? `Out of scope:\n${spec.outOfScope.map((c) => `- ${c}`).join("\n")}\n\n` : "") +
    `Application model:\n${JSON.stringify(projection)}`;

  const { content } = await llm(prompt, {
    systemInstruction: SPEC_COMPARE_SYSTEM,
    json: true,
    role: "lite",
    stage: "spec_compare",
  });

  const raw: any = parseJson(content);
  const gaps = Array.isArray(raw?.gaps) ? raw.gaps : [];
  const pageUrls = new Set(appModel.pages.map((p) => p.url));
  const out: string[] = [];
  for (const g of gaps) {
    const parsed = CompareGap.safeParse(g);
    if (!parsed.success) continue;
    const gap = parsed.data;
    // The deterministic half: the reference must exist, or the warning is the model's invention.
    if (gap.kind === "untestable_rule" && !(gap.rule && gap.rule >= 1 && gap.rule <= spec.rules.length)) continue;
    if (gap.kind === "unmentioned" && !(gap.url && pageUrls.has(gap.url))) continue;
    const message = gap.message.trim().replace(/\s+/g, " ").slice(0, MAX_WARNING_CHARS);
    if (message && !out.includes(message)) out.push(message);
    if (out.length >= MAX_COMPARE_WARNINGS) break;
  }
  if (out.length > 0 && isCacheableResult(out)) llmCacheSet(key, out, SPEC_CACHE_NS);
  return out;
}

/**
 * Run the comparison for one run and record its warnings. NEVER THROWS and never fails the run:
 * warnings are informational. A failure is logged and the panel simply shows none.
 */
export async function runSpecComparison(runId: string, spec: SpecModel, appModel: AppModel): Promise<void> {
  setRunSpecWarnings(runId, { warnings: [], done: false });
  try {
    const warnings = await compareSpecToApp(spec, appModel);
    setRunSpecWarnings(runId, { warnings, done: true });
  } catch (err) {
    console.error(`[spec_compare] comparison failed for run ${runId} — continuing without warnings:`,
      (err as Error)?.message ?? err);
    setRunSpecWarnings(runId, { warnings: [], done: true });
  }
}
