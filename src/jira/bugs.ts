import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { textToAdf } from "./adf.js";
import { call, JIRA_API_BASE, JiraError } from "./client.js";
import type { JiraConnection, JiraSite } from "./session.js";

/**
 * "Create Jira bug" (D-85): from a failed case, a person fills a form and Testbench creates the
 * issue in the Jira project and issue type they chose, attaches the screenshot, and links the story.
 *
 * Every Atlassian URL, body and field rule here was read from the REST v3 OpenAPI spec
 * (`swagger-v3.v3.json`, fetched 2026-11-17), not recalled:
 *   - GET  /project/search?action=create            projects the user may create issues in
 *   - GET  /issue/createmeta/{project}/issuetypes   issue types (`issueTypes`, older `createMetaIssueType`)
 *   - GET  /issue/createmeta/{project}/issuetypes/{type}  fields (`fields`, older `results`), each
 *          with `required`, `hasDefaultValue`, `schema` {type, items, system, custom}, `allowedValues`
 *   - POST /issue                                   201 {id, key}; 400 ErrorCollection {errorMessages, errors}
 *   - POST /issue/{key}/attachments                 multipart part `file`, header X-Atlassian-Token: no-check
 *   - GET  /issueLinkType, POST /issueLink          {type, inwardIssue, outwardIssue}
 *   - `description`, `environment` and `textarea` custom fields take ADF; `textfield` takes a string.
 * The first three need `read:jira-work`; the last three `write:jira-work`.
 *
 * THE FORM IS A PROPOSAL; THIS FILE IS THE CHECK. The browser builds its form from the field list
 * below, but what it sends back is never trusted: `buildIssueFields` re-reads the field list from
 * Jira on every create and checks every value against it — the field exists for this project and
 * type, the value is the right kind, a choice is one of Jira's own options, and every required field
 * is there. That is the project's central rule (CLAUDE.md): a check on structure, not on text.
 */

const PAGE = 200;
const MAX_PAGES = 10;
/** Jira's own limit for a single-line text field, `summary` included. */
const TEXT_MAX = 255;
/** Jira's limit on a rich-text field is 32,767 characters; stay under it with room for structure. */
const RICHTEXT_MAX = 30_000;
/** Jira Cloud's default attachment limit is far larger; a step screenshot is well under 1 MB. */
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;

/** Fields Testbench sets itself (project, type) or never sets (attachments and links go separately). */
const SET_BY_US = new Set(["project", "issuetype", "attachment", "issuelinks"]);

export type FieldKind = "text" | "richtext" | "number" | "date" | "datetime" | "select" | "multiselect" | "labels" | "unsupported";

export interface BugField {
  id: string;
  name: string;
  /** Required AND Jira has no default for it — the form cannot be sent without it. */
  required: boolean;
  kind: FieldKind;
  /** Jira's own choices, for select and multiselect. */
  options?: { id: string; label: string }[];
  /** Why an unsupported field cannot be filled here. */
  note?: string;
}

export interface BugProject { id: string; key: string; name: string }
export interface BugIssueType { id: string; name: string; description: string }

/** A failure whose message is shown to the user, with Jira's per-field messages when it gave them. */
export class JiraBugError extends JiraError {
  constructor(message: string, status: number, readonly fieldErrors: Record<string, string> = {}, signedOut = false) {
    super(message, status, signedOut);
    this.name = "JiraBugError";
  }
}

// ---------------------------------------------------------------------------
// Talking to Jira
// ---------------------------------------------------------------------------

function api(site: JiraSite): string {
  return `${JIRA_API_BASE}/${encodeURIComponent(site.id)}/rest/api/3`;
}

function auth(conn: JiraConnection): Record<string, string> {
  return { Authorization: `Bearer ${conn.accessToken}`, Accept: "application/json" };
}

/** The statuses every call answers the same way. `what` names the thing, for the message. */
async function failFor(res: Response, what: string): Promise<never> {
  if (res.status === 401) throw new JiraBugError("Your Jira sign-in has expired. Click \"Connect Jira\" again.", 401, {}, true);
  if (res.status === 429) {
    const wait = Number(res.headers.get("Retry-After"));
    throw new JiraBugError(`Jira is busy right now. Try again${Number.isFinite(wait) && wait > 0 ? ` in ${wait} seconds` : " shortly"}.`, 429);
  }
  if (res.status === 403) throw new JiraBugError(`Jira didn't allow ${what}. Your Jira account may not have permission for it.`, 403);
  if (res.status === 404) throw new JiraBugError(`Jira couldn't find ${what}, or your Jira account can't see it.`, 404);
  throw new JiraBugError(`Jira returned an error (${res.status}) for ${what}.`, 502);
}

async function getJson(conn: JiraConnection, url: string, what: string): Promise<any> {
  const res = await call(url, { headers: auth(conn) });
  if (!res.ok) await failFor(res, what);
  return res.json().catch(() => ({}));
}

/** Projects this user may create issues in, by name. `query` matches name or key (Jira's own search). */
export async function listCreatableProjects(
  conn: JiraConnection, site: JiraSite, opts: { query?: string; startAt?: number } = {},
): Promise<{ projects: BugProject[]; startAt: number; total: number; isLast: boolean }> {
  const q = new URLSearchParams({ action: "create", orderBy: "name", maxResults: "50", startAt: String(Math.max(0, opts.startAt ?? 0)) });
  if (opts.query?.trim()) q.set("query", opts.query.trim().slice(0, 100));
  const body = await getJson(conn, `${api(site)}/project/search?${q}`, "the project list");
  const values: any[] = Array.isArray(body.values) ? body.values : [];
  const projects = values
    .filter((p) => p && typeof p.id === "string" && typeof p.key === "string" && !p.archived && !p.deleted)
    .map((p) => ({ id: p.id as string, key: p.key as string, name: String(p.name ?? p.key) }));
  return {
    projects,
    startAt: Number(body.startAt) || 0,
    total: Number.isFinite(Number(body.total)) ? Number(body.total) : projects.length,
    isLast: body.isLast !== false,
  };
}

/** One page after another until Jira has given everything, or MAX_PAGES (a runaway guard). */
async function allPages(conn: JiraConnection, base: string, what: string, pick: (body: any) => unknown[]): Promise<any[]> {
  const out: any[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await getJson(conn, `${base}?startAt=${out.length}&maxResults=${PAGE}`, what);
    const items = pick(body);
    out.push(...items);
    const total = Number(body.total);
    if (!items.length || !Number.isFinite(total) || out.length >= total) break;
  }
  return out;
}

/** The issue types this user may create in the project. Sub-tasks are left out: they need a parent. */
export async function listIssueTypes(conn: JiraConnection, site: JiraSite, projectId: string): Promise<BugIssueType[]> {
  const items = await allPages(conn, `${api(site)}/issue/createmeta/${encodeURIComponent(projectId)}/issuetypes`, "this project's issue types",
    (b) => (Array.isArray(b.issueTypes) ? b.issueTypes : Array.isArray(b.createMetaIssueType) ? b.createMetaIssueType : []));
  return items
    .filter((t) => t && typeof t.id === "string" && !t.subtask)
    .map((t) => ({ id: t.id as string, name: String(t.name ?? t.id), description: String(t.description ?? "") }));
}

/** The fields of the create screen for this project and issue type, ready for the form. */
export async function getCreateFields(conn: JiraConnection, site: JiraSite, projectId: string, issueTypeId: string): Promise<BugField[]> {
  const raw = await allPages(conn,
    `${api(site)}/issue/createmeta/${encodeURIComponent(projectId)}/issuetypes/${encodeURIComponent(issueTypeId)}`,
    "the fields for this issue type",
    (b) => (Array.isArray(b.fields) ? b.fields : Array.isArray(b.results) ? b.results : []));
  return normalizeFields(raw);
}

/** Create the issue. Jira's per-field complaints come back keyed by field id, named by field name. */
export async function createIssue(
  conn: JiraConnection, site: JiraSite, fields: Record<string, unknown>, nameOf: (id: string) => string = (id) => id,
): Promise<{ id: string; key: string; link: string }> {
  const res = await call(`${api(site)}/issue`, {
    method: "POST",
    headers: { ...auth(conn), "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (res.status === 400 || res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { errorMessages?: unknown; errors?: unknown };
    const fieldErrors: Record<string, string> = {};
    if (body.errors && typeof body.errors === "object") {
      for (const [k, v] of Object.entries(body.errors as Record<string, unknown>)) if (typeof v === "string") fieldErrors[k] = v;
    }
    const messages = [
      ...(Array.isArray(body.errorMessages) ? body.errorMessages.filter((m): m is string => typeof m === "string") : []),
      ...Object.entries(fieldErrors).map(([k, v]) => `${nameOf(k)}: ${v}`),
    ];
    throw new JiraBugError(`Jira didn't accept the issue. ${messages.join(" ") || "It gave no reason."}`.trim(), 400, fieldErrors);
  }
  if (res.status === 403) {
    throw new JiraBugError("Jira didn't allow creating this issue. Your Jira account may not be allowed to create issues in this project.", 403);
  }
  if (!res.ok) await failFor(res, "the new issue");
  const body = (await res.json().catch(() => ({}))) as { id?: unknown; key?: unknown };
  if (typeof body.key !== "string" || !body.key) throw new JiraBugError("Jira's reply had no issue key.", 502);
  return {
    id: String(body.id ?? ""),
    key: body.key,
    link: site.url ? `${site.url.replace(/\/+$/, "")}/browse/${encodeURIComponent(body.key)}` : "",
  };
}

/** Attach one file. Jira's documented multipart shape: a part named `file`, plus the no-check header. */
export async function attachFile(conn: JiraConnection, site: JiraSite, issueKey: string, filePath: string): Promise<void> {
  const size = statSync(filePath).size;
  if (size > ATTACH_MAX_BYTES) throw new JiraBugError("The screenshot is too large to attach.", 413);
  const form = new FormData();
  form.append("file", new Blob([readFileSync(filePath)], { type: "image/png" }), path.basename(filePath));
  const res = await call(`${api(site)}/issue/${encodeURIComponent(issueKey)}/attachments`, {
    method: "POST",
    headers: { ...auth(conn), "X-Atlassian-Token": "no-check" },
    body: form,
  });
  if (!res.ok) await failFor(res, "the screenshot upload");
}

/**
 * Link the new issue to a story with Jira's "Relates" link type. Looked up by name, not assumed:
 * a Jira admin can rename or delete link types, and then this says so instead of guessing another.
 */
export async function linkRelates(conn: JiraConnection, site: JiraSite, issueKey: string, otherKey: string): Promise<void> {
  const body = await getJson(conn, `${api(site)}/issueLinkType`, "the link types");
  const types: any[] = Array.isArray(body.issueLinkTypes) ? body.issueLinkTypes : [];
  const relates = types.find((t) => t && typeof t.name === "string" && /^relates$/i.test(t.name.trim()));
  if (!relates) throw new JiraBugError("This Jira has no \"Relates\" link type, so the story wasn't linked.", 422);
  const res = await call(`${api(site)}/issueLink`, {
    method: "POST",
    headers: { ...auth(conn), "Content-Type": "application/json" },
    body: JSON.stringify({ type: { name: relates.name }, inwardIssue: { key: otherKey }, outwardIssue: { key: issueKey } }),
  });
  if (!res.ok) await failFor(res, otherKey);
}

// ---------------------------------------------------------------------------
// Fields: Jira's create metadata -> the form, and the form -> Jira's `fields` body
// ---------------------------------------------------------------------------

function optionsOf(allowed: unknown): { id: string; label: string }[] | null {
  if (!Array.isArray(allowed) || !allowed.length) return null;
  const out: { id: string; label: string }[] = [];
  for (const v of allowed) {
    if (!v || typeof v !== "object" || typeof (v as any).id !== "string") return null; // no id, no way to send it
    const o = v as Record<string, unknown>;
    if (o.disabled === true || o.archived === true) continue; // Jira refuses a disabled or archived choice
    out.push({ id: o.id as string, label: String(o.name ?? o.value ?? o.id) });
  }
  return out;
}

const PERSON_TYPES = new Set(["user", "group"]);

function kindOf(m: any): { kind: FieldKind; options?: { id: string; label: string }[]; note?: string } {
  const schema = (m && typeof m.schema === "object" && m.schema) || {};
  const type = String(schema.type ?? "");
  const items = String(schema.items ?? "");
  const system = String(schema.system ?? "");
  const custom = String(schema.custom ?? "");
  if (PERSON_TYPES.has(type) || PERSON_TYPES.has(items)) {
    return { kind: "unsupported", note: "Picking a person isn't available here yet. Set it in Jira after creating." };
  }
  if (system === "description" || system === "environment" || custom.endsWith(":textarea")) return { kind: "richtext" };
  const options = optionsOf(m.allowedValues);
  if (options) return { kind: type === "array" ? "multiselect" : "select", options };
  if (type === "array" && items === "string") return { kind: "labels" };
  if (type === "string") return { kind: "text" };
  if (type === "number") return { kind: "number" };
  if (type === "date") return { kind: "date" };
  if (type === "datetime") return { kind: "datetime" };
  return { kind: "unsupported", note: "This kind of field can't be filled from Testbench yet. Set it in Jira after creating." };
}

/** Jira's create metadata -> the fields the form shows. Fields Testbench sets itself are left out. */
export function normalizeFields(raw: unknown[]): BugField[] {
  const out: BugField[] = [];
  for (const m of raw as any[]) {
    const id = typeof m?.fieldId === "string" ? m.fieldId : typeof m?.key === "string" ? m.key : "";
    if (!id || SET_BY_US.has(id)) continue;
    const k = kindOf(m);
    out.push({
      id,
      name: String(m.name ?? id),
      // A field Jira fills by default (reporter, often priority) does not block the form.
      required: m.required === true && m.hasDefaultValue !== true,
      kind: k.kind,
      ...(k.options ? { options: k.options } : {}),
      ...(k.note ? { note: k.note } : {}),
    });
  }
  // Summary first, then description, then the rest as Jira ordered them.
  const rank = (f: BugField) => (f.id === "summary" ? 0 : f.id === "description" ? 1 : 2);
  return out.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map(({ f }) => f);
}

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "")
  || (Array.isArray(v) && v.length === 0);

/** One value, checked against its field and turned into the shape Jira takes. A string is an error. */
function convert(f: BugField, v: unknown): { value: unknown } | { error: string } {
  switch (f.kind) {
    case "text": {
      if (typeof v !== "string") return { error: "must be text" };
      const t = v.trim().replace(/[\r\n]+/g, " ");
      return t.length > TEXT_MAX ? { error: `must be ${TEXT_MAX} characters or fewer` } : { value: t };
    }
    case "richtext": {
      if (typeof v !== "string") return { error: "must be text" };
      return v.length > RICHTEXT_MAX ? { error: `must be ${RICHTEXT_MAX} characters or fewer` } : { value: textToAdf(v) };
    }
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
      return Number.isFinite(n) ? { value: n } : { error: "must be a number" };
    }
    case "date": {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
        return { error: "must be a date (YYYY-MM-DD)" };
      }
      return { value: v };
    }
    case "datetime": {
      const ms = typeof v === "string" ? Date.parse(v) : NaN;
      // Jira's documented datetime form is yyyy-MM-ddTHH:mm:ss.SSS+0000.
      return Number.isNaN(ms) ? { error: "must be a date and time" } : { value: new Date(ms).toISOString().replace("Z", "+0000") };
    }
    case "select": {
      if (typeof v !== "string" || !f.options?.some((o) => o.id === v)) return { error: "must be one of Jira's choices" };
      return { value: { id: v } };
    }
    case "multiselect": {
      const list = Array.isArray(v) ? v : [v];
      if (!list.every((x) => typeof x === "string" && f.options?.some((o) => o.id === x))) return { error: "must be Jira's choices" };
      return { value: [...new Set(list as string[])].map((id) => ({ id })) };
    }
    case "labels": {
      const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : null;
      if (!list || !list.every((x) => typeof x === "string")) return { error: "must be words" };
      const labels = [...new Set((list as string[]).map((x) => x.trim()).filter(Boolean))];
      if (labels.some((l) => l.length > TEXT_MAX)) return { error: "has a label that is too long" };
      return { value: labels };
    }
    default:
      return { error: f.note ?? "can't be filled from Testbench" };
  }
}

export type BuildResult =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; error: string; fieldErrors: Record<string, string> };

/**
 * What the user filled in -> Jira's `fields` body, or the reasons it can't be sent. `meta` is the
 * field list just read from Jira, never the one the browser had. Blank optional fields are dropped;
 * a field that is not on this project's create screen is refused rather than passed through.
 */
export function buildIssueFields(meta: BugField[], input: unknown, projectId: string, issueTypeId: string): BuildResult {
  const fieldErrors: Record<string, string> = {};
  const fields: Record<string, unknown> = { project: { id: projectId }, issuetype: { id: issueTypeId } };
  const values = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const byId = new Map(meta.map((f) => [f.id, f]));

  for (const [id, v] of Object.entries(values).slice(0, 200)) {
    const f = byId.get(id);
    if (!f) { fieldErrors[id] = "isn't a field of this issue type in this project"; continue; }
    if (isBlank(v)) continue;
    const r = convert(f, v);
    if ("error" in r) fieldErrors[id] = `${f.name} ${r.error}`;
    else if (!isBlank(r.value) && !(f.kind === "richtext" && (r.value as { content: unknown[] }).content.length === 0)) fields[id] = r.value;
  }
  for (const f of meta) {
    if (!f.required || fieldErrors[f.id] || f.id in fields) continue;
    fieldErrors[f.id] = f.kind === "unsupported"
      ? `${f.name} is required in this project but can't be filled from Testbench yet. Create this issue in Jira instead.`
      : `${f.name} is required`;
  }
  if (Object.keys(fieldErrors).length) {
    return { ok: false, error: Object.values(fieldErrors).join(". ") + ".", fieldErrors };
  }
  return { ok: true, fields };
}
