import type { TestCase } from "./testCases.js";

/**
 * Data-driven runs: a request with `{Column}` placeholders and a `Data:` block of CSV rows runs once
 * per row, each case with its own values and checks.
 *
 *   Create an Account named {Name} with Industry {Industry}, then verify the industry
 *   Data:
 *   Name,Industry
 *   O'Connor & Sons,Banking
 *   "Zeta-9 Labs, Inc",Not For Profit
 *
 * The whole pipeline (plan, discovery, cases, IR) runs on row 1's request. The request's case is then
 * copied once per further row with row 1's values swapped for that row's, and each copy carries its
 * own request (`rowPrompt`) so the IR passes that restore request values restore THAT row's.
 */
export interface DataRows {
  /** The request filled with each row, in row order. */
  prompts: string[];
  rows: Record<string, string>[];
}

/** One CSV line: commas split, double quotes group, "" is a quote. */
function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** The rows of a data-driven request, or null for an ordinary one (no `Data:` block, fewer than one
 *  row, or no `{Column}` of the header used in the request). */
export function dataRowsOf(text: string): DataRows | null {
  const m = /^[ \t]*data[ \t]*:[ \t]*$/im.exec(text);
  if (!m) return null;
  const template = text.slice(0, m.index).trim();
  const lines = text.slice(m.index + m[0].length).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const header = csvLine(lines[0]);
  const used = header.filter((h) => h && new RegExp(`\\{${escape(h)}\\}`, "i").test(template));
  if (!used.length) return null;
  const rows = lines.slice(1).map((l) => {
    const cells = csvLine(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
  const prompts = rows.map((r) => used.reduce(
    (p, h) => p.replace(new RegExp(`\\{${escape(h)}\\}`, "gi"), () => r[h]), template));
  return { prompts, rows };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The request's case for rows 2..N: row 1's values (longest first, so "Acme Corp" wins over "Acme")
 * replaced by that row's in the title, steps and expected result. Two passes through markers, so a
 * value that equals another column's value in row 1 is never replaced twice.
 * ponytail: plain text swap, so a value the case writer reworded (75000 written "75,000") stays row 1's;
 * the row's own `rowPrompt` still lets the IR's request-value restore put the right one back.
 */
export function rowCases(primary: TestCase, data: DataRows): TestCase[] {
  const first = data.rows[0];
  const cols = Object.keys(first).filter((c) => first[c]).sort((a, b) => first[b].length - first[a].length);
  return data.rows.slice(1).map((row, k) => {
    const swap = (s: string) => {
      let t = s;
      cols.forEach((c, i) => { t = t.split(first[c]).join(`\u0000${i}\u0000`); });
      cols.forEach((c, i) => { t = t.split(`\u0000${i}\u0000`).join(row[c] ?? ""); });
      return t;
    };
    return {
      ...primary,
      title: `${swap(primary.title)} (row ${k + 2})`,
      steps: primary.steps.map(swap),
      expected: swap(primary.expected),
      rowPrompt: data.prompts[k + 1],
    };
  });
}
