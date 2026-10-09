import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IR, Target } from "../src/schema/ir.js";
import { AppModel, Element } from "../src/schema/appModel.js";

/**
 * Phase 1 of the live-DOM discovery stream: `Target.frame` and the new optional `Element` fields.
 *
 * The standard being enforced is the one `Target.groundedAt` was added to — additive and
 * optional, so every STORED document still parses and, with `DISCOVERY_LIVE_DOM` off, comes back
 * out byte-identical. "Still parses" is the weak half of that: Zod strips unknown keys, so a
 * parse that silently DROPPED or ADDED a key would pass `safeParse().success` and still be a
 * behaviour change. Hence these compare the parsed result to the stored JSON, not just success.
 *
 * The fixtures are real saved runs (copied out of the gitignored `runs/`), not hand-written, so
 * they cannot drift from what the pipeline actually produced — the same reasoning as
 * `irGroqToGeminiReplay.test.ts`.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

/** Every `*.json` under tests/fixtures, one directory deep. */
function fixtureFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const f of readdirSync(join(FIXTURES, entry.name))) {
      if (f.endsWith(".json")) out.push(join(entry.name, f));
    }
  }
  return out.sort();
}

const load = (rel: string): any => JSON.parse(readFileSync(join(FIXTURES, rel), "utf8"));

describe("Target.frame — additive and optional", () => {
  const irFiles = fixtureFiles().filter((f) => f.endsWith("04-ir.json"));

  it("has real saved IR fixtures to check against", () => {
    // Guard against the loop below passing vacuously if the fixtures move.
    expect(irFiles.length).toBeGreaterThanOrEqual(4);
  });

  it.each(irFiles)("%s: a stored IR parses, and no step target gains or loses a key", (rel) => {
    const raw = load(rel);
    const stored = raw.ir ?? raw; // run-level files wrap { ir, updatedAppModel }
    const parsed = IR.safeParse(stored);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (!parsed.success) return;

    parsed.data.steps.forEach((step, i) => {
      const before = stored.steps[i].target;
      const after = step.target;
      if (!before) { expect(after).toBeUndefined(); return; }
      expect(after).toBeDefined();
      // Exact key-set equality: nothing dropped, and crucially `frame` NOT materialised.
      expect(Object.keys(after!).sort()).toEqual(Object.keys(before).sort());
      expect(after).not.toHaveProperty("frame");
    });
  });

  it("round-trips a frame path untouched", () => {
    const t = Target.parse({ role: "button", name: "Save", css: "#save", frame: "iframe#report" });
    expect(t.frame).toBe("iframe#report");
  });

  it("round-trips a nested frame path, segments joined by ' >>> '", () => {
    const frame = "iframe#outer >>> iframe[name=inner]";
    expect(Target.parse({ css: "#go", frame }).frame).toBe(frame);
  });

  it("does not default a missing frame to an empty string", () => {
    // An empty string would be truthy-checked inconsistently downstream; absent must stay absent.
    expect(Target.parse({ css: "#go" })).not.toHaveProperty("frame");
  });

  it("rejects a non-string frame", () => {
    expect(Target.safeParse({ css: "#go", frame: 3 }).success).toBe(false);
    expect(Target.safeParse({ css: "#go", frame: ["iframe"] }).success).toBe(false);
  });

  it("still accepts groundedAt next to frame — the two provenance/addressing fields coexist", () => {
    const t = Target.parse({ css: "#go", frame: "iframe#f", groundedAt: "replay" });
    expect(t.groundedAt).toBe("replay");
    expect(t.frame).toBe("iframe#f");
  });
});

describe("Element live-DOM fields — additive and optional", () => {
  const appModels: Array<{ label: string; model: any }> = [];
  for (const rel of fixtureFiles()) {
    const raw = load(rel);
    if (rel.endsWith("02-appmodel.json")) appModels.push({ label: rel, model: raw });
    else if (raw?.updatedAppModel) appModels.push({ label: `${rel}#updatedAppModel`, model: raw.updatedAppModel });
  }

  it("has real saved AppModels to check against", () => {
    expect(appModels.length).toBeGreaterThanOrEqual(4);
  });

  it.each(appModels.map((a) => [a.label, a.model] as const))(
    "%s: parses, and no element gains or loses a key",
    (_label, model) => {
      const parsed = AppModel.safeParse(model);
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
      if (!parsed.success) return;

      parsed.data.pages.forEach((page, p) => {
        const storedEls: any[] = model.pages[p].elements ?? [];
        expect(page.elements.length).toBe(storedEls.length);
        page.elements.forEach((el, e) => {
          // None of the live-walker fields may appear on a model the cheerio path produced.
          for (const k of ["frame", "inShadow", "nameSource", "visibleSource"]) {
            expect(el, `${k} must not be materialised`).not.toHaveProperty(k);
          }
          expect(Object.keys(el).sort()).toEqual(Object.keys(storedEls[e]).sort());
        });
      });
    },
  );
});

describe("Element live-DOM fields — round trip", () => {
  it("carries frame, inShadow, nameSource and visibleSource when the live walker sets them", () => {
    const el = Element.parse({
      role: "textbox", name: "Username", css: "#username", visible: true,
      frame: "iframe#login", inShadow: true, nameSource: "label", visibleSource: "computed",
    });
    expect(el).toMatchObject({ frame: "iframe#login", inShadow: true, nameSource: "label", visibleSource: "computed" });
  });

  it("accepts a nameSource the schema has never heard of — a new accname rule must not invalidate a stored model", () => {
    expect(Element.safeParse({ role: "button", name: "Go", nameSource: "some-future-rule" }).success).toBe(true);
  });

  it("only ever accepts visibleSource 'computed'", () => {
    expect(Element.safeParse({ role: "button", name: "Go", visibleSource: "assumed" }).success).toBe(false);
  });
});
