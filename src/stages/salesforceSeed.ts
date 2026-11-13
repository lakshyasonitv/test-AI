import type { SalesforceOrgModel } from "../schema/appModel.js";
import type { FrontdoorSession } from "./salesforceFrontdoor.js";
import { fitToField } from "./testData.js";

/**
 * Phase D, seeding (SALESFORCE_SEED_ENABLED, default off): what a test needs that no screen can do,
 * done through the API before the cases are written.
 *
 * Today: a platform-event flow. Nothing in Lightning publishes an event, so a request about one (TB Event
 * Create Account) could never be tested. When the request names such a flow, its event is published ONCE,
 * with every text field of the event set to "TB Event <uid>", and the org model the case writer reads says
 * so, with the value in place of "the triggering record's <Field>". The case then checks the outcome on
 * screen (the Account the flow created, by that exact name). Both the grounding replay and the spec run
 * after the publish, so both see the record.
 *
 * Not covered: scheduled flows. Salesforce has no API to run a scheduled flow now; they run at their time.
 */
export function seedEnabled(): boolean {
  return process.env.SALESFORCE_SEED_ENABLED === "true";
}

export interface Published {
  flow: string; event: string; values: Record<string, string>; id?: string; error?: string;
  /** What the flow makes from it, by its run-unique name: cleanup deletes it (salesforceCleanup.ts). */
  creates?: { object: string; name: string }[];
}

type Session = Required<Pick<FrontdoorSession, "apiGet" | "apiPost">>;
type Flow = NonNullable<SalesforceOrgModel["flows"]>[number];

const words = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** The platform-event flows a request is about: named by label or API name, or the only one when the
 *  request says "platform event". */
export function requestedEventFlows(org: Pick<SalesforceOrgModel, "flows"> | undefined, request: string): Flow[] {
  const all = (org?.flows ?? []).filter((f) => f.type === "platform-event" && f.event);
  const req = words(request);
  const named = all.filter((f) => [f.label, f.api, f.event!].some((n) => req.includes(words(n.replace(/__e$/, "")))));
  if (named.length) return named;
  return all.length === 1 && /\bplatform[- ]event\b/i.test(request) ? all : [];
}

/** Publish each requested event once and write what was published into the flow's lines (mutates `org`). */
export async function publishRequestedEvents(session: Session, org: SalesforceOrgModel, request: string, uid: string): Promise<Published[]> {
  const out: Published[] = [];
  for (const flow of requestedEventFlows(org, request)) {
    const event = flow.event!;
    const values: Record<string, string> = {};
    try {
      const d = await session.apiGet(`/sobjects/${event}/describe`);
      for (const f of d?.fields ?? []) {
        if (!f?.createable || !/__c$/.test(f?.name ?? "") || !/^(string|textarea)$/.test(f?.type ?? "")) continue;
        values[f.name] = `TB Event ${uid}`.slice(0, Math.max(1, Number(f.length) || 255));
      }
      const res = await session.apiPost(`/sobjects/${event}/`, values);
      out.push({ flow: flow.label, event, values, ...(typeof res?.id === "string" ? { id: res.id } : {}) });
    } catch (err) {
      out.push({ flow: flow.label, event, values, error: (err as Error)?.message ?? String(err) });
      continue;
    }
    const lines = (flow.effects ?? []).map((l) => l.replace(/ with (\w+) = the triggering record's (\w+)/g,
      (m, _field, from) => values[from] ? ` "${values[from]}"` : m));
    const sent = Object.entries(values).map(([k, v]) => `${k} = "${v}"`).join(", ");
    // How to find what it made: run 2026-11-10T13-21-35-459Z-e0311135 wrote a "publish" step and clicked the
    // nav bar's "Accounts List" menu, so the list's search box was never on screen.
    const made = lines.map((l) => /creates an? (\w+) "([^"]+)"/.exec(l)).find(Boolean);
    // Global search: a list opens on "Recently Viewed", which never holds a record nobody opened (run
    // 2026-11-10T13-35-43-065Z-74193e13 searched it and found "Nothing to see here").
    const find = made ? ` To check it: click the header's "Search..." box, type "${made[2]}", press Enter, and assert the link "${made[2]}" is visible in the results.` : "";
    lines.unshift(`Testbench ALREADY PUBLISHED this event once before the test, through the API (${event}${sent ? ` with ${sent}` : ""}). The case writes NO publish step; it only checks what the flow did.${find}`);
    flow.effects = lines;
    const all = lines.map((l) => /creates an? (\w+) "([^"]+)"/.exec(l)).filter((m): m is RegExpExecArray => !!m);
    if (all.length) out[out.length - 1].creates = all.map((m) => ({ object: m[1], name: m[2] }));
  }
  return out;
}

/** A case's steps up to its own "publish the event" step: everything from there on re-does what seeding
 *  did, then checks again (a second search, on a page whose search box is another one). */
export function withoutPublishSteps<C extends { steps: string[] }>(cases: C[]): C[] {
  return cases.map((c) => {
    const at = c.steps.findIndex((s) => /\bpublish(es|ed|ing)?\b/i.test(s));
    if (at < 0) return c;
    // Checked already before it (search, open, look): the rest repeats that check. Else only the publish goes.
    const checked = c.steps.slice(0, at).some((s) => /\b(search|type|open|look|find|verify|check)\b/i.test(s) && !/^go to\b/i.test(s));
    return { ...c, steps: checked ? c.steps.slice(0, at) : c.steps.filter((_, i) => i !== at) };
  });
}

/**
 * Phase D gap "pre-made records": a request about an EXISTING record ("Create a Contact for an existing
 * Account") gets that record made through the API before the cases, named "TB Seed <uid>", every required
 * field filled by its type. It is marked as viewed (SOQL FOR VIEW) so a lookup finds it in Recent Items
 * before the search index has it. Written into the org model (org.seeded) for the case writer; cleanup
 * deletes it by that name. A required lookup it cannot fill = not seeded.
 */
export async function seedExistingRecords(session: Session, org: SalesforceOrgModel, request: string, uid: string): Promise<{ object: string; name: string; id?: string; error?: string }[]> {
  const out: { object: string; name: string; id?: string; error?: string }[] = [];
  const asked = [...request.matchAll(/\b(?:an?\s+)?(?:existing|pre-?existing|already existing)\s+([A-Za-z][\w ]{1,40}?)(?=\b(?:\s+(?:and|with|that|for|then|to|in|on)\b|[.,;]|$))/gi)].map((m) => m[1].trim().toLowerCase());
  const name = `TB Seed ${uid}`;
  /**
   * One record of `api`, its required fields filled by type. A required lookup (a master-detail parent, a
   * custom object that must belong to an Account) is a parent made first, the same way, up to two levels:
   * such a record used to be refused ("not seeded: its required lookup"). Parents go into `out` BEFORE the
   * child, so cleanup (which deletes in reverse) removes the child first. Returns the new id, or an error.
   */
  const seedOne = async (api: string, depth: number): Promise<{ id?: string; error?: string }> => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(api)) return { error: `bad object name ${api}` };
    const done = out.find((r) => r.object === api && r.id);
    if (done) return { id: done.id };
    const o = org.objects.find((x) => x.api === api);
    const body: Record<string, unknown> = {};
    for (const f of (o?.fields ?? []).filter((x) => x.required)) {
      if (f.lookup) {
        const parent = f.lookup.split("/")[0];
        if (depth >= 2 || !parent) return { error: `its required lookup ${f.label}` };
        const p = await seedOne(parent, depth + 1);
        if (!p.id) return { error: `its required lookup ${f.label} (${p.error ?? "parent not made"})` };
        body[f.api] = p.id;
        continue;
      }
      body[f.api] = /^(string|textarea)$/i.test(f.type) ? fitToField(name, f)
        : /picklist/i.test(f.type) ? f.picklist?.[0]
        : /email/i.test(f.type) ? `tb+${uid}@example.com`
        : /phone/i.test(f.type) ? "4155550100"
        : /^(double|currency|percent|int|long)$/i.test(f.type) ? 1
        : /^date$/i.test(f.type) ? new Date().toISOString().slice(0, 10)
        : /boolean/i.test(f.type) ? false : name;
    }
    // Name fields the org fills itself (Contact's LastName is required; Account's Name too): one at least. A
    // parent outside the org model gets just its name.
    if (!Object.values(body).includes(name)) {
      const nameField = o?.fields.find((x) => /^(Name|LastName|Subject)$/.test(x.api))?.api ?? (o ? undefined : (api === "Contact" || api === "Lead" ? "LastName" : "Name"));
      if (nameField) body[nameField] = name;
    }
    try {
      const res = await session.apiPost(`/sobjects/${api}/`, body);
      const id = typeof res?.id === "string" ? res.id : undefined;
      if (id) await session.apiGet(`/query?q=${encodeURIComponent(`SELECT Id FROM ${api} WHERE Id = '${id}' FOR VIEW`)}`).catch(() => null);
      out.push({ object: api, name, ...(id ? { id } : {}) });
      (org.seeded ??= []).push({ object: api, label: o?.label ?? api, name });
      return id ? { id } : { error: "the API returned no id" };
    } catch (err) {
      return { error: (err as Error)?.message ?? String(err) };
    }
  };
  for (const want of new Set(asked)) {
    const o = org.objects.find((x) => [x.label, x.labelPlural, x.api].some((n) => n?.toLowerCase() === want || n?.toLowerCase() === want.replace(/s$/, "")));
    if (!o || !/^[A-Za-z][A-Za-z0-9_]*$/.test(o.api) || out.some((r) => r.object === o.api)) continue;
    const r = await seedOne(o.api, 0);
    if (r.error) out.push({ object: o.api, name, error: `not seeded: ${r.error}` });
  }
  return out;
}
