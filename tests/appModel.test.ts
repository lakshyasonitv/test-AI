import { describe, it, expect, afterEach } from "vitest";
import { toLiteModel, compressRepetitiveSiblings, type AppModel, type NavigationItem, type Element } from "../src/schema/appModel.js";

// Caps are read lazily from process.env per call (not module-level) — mirrors ir.ts's own
// MAX_ATTEMPTS/MAX_EXTENSIONS, which are read inside toIR() per call for the same reason. Tests
// can therefore just set/restore process.env directly, no vi.resetModules()/re-import needed.
const withEnv = (vars: Record<string, string>, fn: () => void) => {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  try { fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
};

const page = (extra: Record<string, unknown> = {}) => ({
  url: "https://x.example/", title: "X", concepts: [], elements: [], ...extra,
});
const model = (pages: any[]): AppModel => ({ baseUrl: "https://x.example", pages }) as AppModel;

afterEach(() => {
  for (const k of [
    "MAX_LITE_ELEMENTS_PER_PAGE", "MAX_LITE_FORMS_PER_PAGE", "MAX_LITE_FORM_FIELDS",
    "MAX_LITE_NAV_NODES_PER_PAGE", "MAX_LITE_NAV_DEPTH", "MAX_LITE_BUTTONS_PER_PAGE",
    "MAX_LITE_HEADINGS_PER_PAGE",
  ]) delete process.env[k];
});

describe("toLiteModel — caps", () => {
  it("caps elements per page, keeping named interactive elements over anonymous ones placed earlier", () => {
    withEnv({ MAX_LITE_ELEMENTS_PER_PAGE: "10" }, () => {
      const anonymous: Element[] = Array.from({ length: 200 }, (_, i) =>
        ({ role: "generic", name: "" }) as Element);
      const named: Element[] = Array.from({ length: 5 }, (_, i) =>
        ({ role: "button", name: `Named ${i}` }) as Element);
      // Anonymous elements placed BEFORE the named ones in array order — a raw positional
      // slice(0, 10) would keep only anonymous elements and drop every named one.
      const m = model([page({ elements: [...anonymous, ...named] })]);
      const out = toLiteModel(m);
      const names = out.pages[0].elements.map((e) => e.name);
      for (const n of named) expect(names).toContain(n.name);
      expect(out.pages[0].elements.length).toBe(10);
    });
  });

  it("caps form count and fields per form independently", () => {
    withEnv({ MAX_LITE_FORMS_PER_PAGE: "2", MAX_LITE_FORM_FIELDS: "3" }, () => {
      const form = (n: number) => ({
        action: "", method: "GET", ariaLabel: "",
        fields: Array.from({ length: 6 }, (_, i) => ({ inputType: "text", name: `f${n}-${i}` })),
      });
      const m = model([page({ forms: [form(1), form(2), form(3)] })]);
      const out = toLiteModel(m);
      expect(out.pages[0].forms?.length).toBe(2);
      for (const f of out.pages[0].forms ?? []) expect(f.fields.length).toBe(3);
    });
  });

  it("caps navigation via one shared breadth+depth node budget, not per-level exponential growth", () => {
    withEnv({ MAX_LITE_NAV_NODES_PER_PAGE: "50", MAX_LITE_NAV_DEPTH: "2" }, () => {
      const leaf = (): NavigationItem => ({ text: "leaf", href: "", children: [], isDropdown: false, ariaLabel: "", role: "link" });
      const tree: NavigationItem[] = Array.from({ length: 40 }, () => ({
        text: "top", href: "", isDropdown: true, ariaLabel: "", role: "link",
        children: Array.from({ length: 40 }, leaf), // 40x40 = 1600+ nodes unbounded
      }));
      const m = model([page({ navigation: tree })]);
      const out = toLiteModel(m);

      const countAndMaxDepth = (items: NavigationItem[], depth: number): { count: number; maxDepth: number } =>
        items.reduce((acc, it) => {
          const child = countAndMaxDepth(it.children ?? [], depth + 1);
          return { count: acc.count + 1 + child.count, maxDepth: Math.max(acc.maxDepth, child.maxDepth, depth) };
        }, { count: 0, maxDepth: depth });

      const { count, maxDepth } = countAndMaxDepth(out.pages[0].navigation ?? [], 0);
      expect(count).toBeLessThanOrEqual(50);
      expect(maxDepth).toBeLessThanOrEqual(2);
    });
  });

  it("caps buttons and headings independently", () => {
    withEnv({ MAX_LITE_BUTTONS_PER_PAGE: "3", MAX_LITE_HEADINGS_PER_PAGE: "4" }, () => {
      const m = model([page({
        buttons: Array.from({ length: 10 }, (_, i) => ({ text: `b${i}`, ariaLabel: "" })),
        headings: Array.from({ length: 10 }, (_, i) => ({ level: 2, text: `h${i}` })),
      })]);
      const out = toLiteModel(m);
      expect(out.pages[0].buttons?.length).toBe(3);
      expect(out.pages[0].headings?.length).toBe(4);
    });
  });

  it("does not change output on a page under every cap — no behavior change for any real run seen so far", () => {
    // Matches this repo's own observed maximum across its sampled runs/*/02-appmodel.json:
    // 87 elements, 2 forms, 9 fields/form, 18 nav nodes, 3 buttons, 28 headings — every default
    // cap sits above all of these.
    const elements: Element[] = Array.from({ length: 87 }, (_, i) => ({ role: "button", name: `e${i}` }) as Element);
    const form = {
      action: "", method: "GET", ariaLabel: "",
      fields: Array.from({ length: 9 }, (_, i) => ({ inputType: "text", name: `f${i}` }))
    };
    const nav: NavigationItem[] = Array.from({ length: 18 }, (_, i) =>
      ({ text: `n${i}`, href: "", children: [], isDropdown: false, ariaLabel: "", role: "link" }));
    const buttons = Array.from({ length: 3 }, (_, i) => ({ text: `b${i}`, ariaLabel: "" }));
    const headings = Array.from({ length: 28 }, (_, i) => ({ level: 2, text: `h${i}` }));
    const m = model([page({ elements, forms: [form, form], navigation: nav, buttons, headings })]);

    const before = JSON.stringify(toLiteModel(m));
    // Re-run to prove determinism/no incidental mutation, not because caps differ.
    const after = JSON.stringify(toLiteModel(m));
    expect(after).toBe(before);
    expect(JSON.parse(before).pages[0].elements.length).toBe(87);
    expect(JSON.parse(before).pages[0].forms.length).toBe(2);
    expect(JSON.parse(before).pages[0].navigation.length).toBe(18);
  });
});

describe("compressRepetitiveSiblings", () => {
  it("compresses identical siblings and preserves unique ones", () => {
    const elements = [
      { role: "button", name: "Add to cart", genericPath: "body>div>ul>li>button" },
      { role: "button", name: "Add to cart", genericPath: "body>div>ul>li>button" },
      { role: "button", name: "Add to cart", genericPath: "body>div>ul>li>button" },
      { role: "button", name: "Add to cart", genericPath: "body>div>ul>li>button" },
      { role: "button", name: "Add to cart", genericPath: "body>div>ul>li>button" },
      { role: "button", name: "Add to cart", genericPath: "body>div>ul>li>button" },
      { role: "button", name: "Add to cart", genericPath: "body>div>ul>li>button" },
      { role: "button", name: "Add to cart", genericPath: "body>div>ul>li>button" },
      { role: "button", name: "Add to cart", genericPath: "body>div>ul>li>button" },
      { role: "button", name: "Add to cart", genericPath: "body>div>ul>li>button" },
      { role: "link", name: "Nike Air Max", genericPath: "body>div>ul>li>a" },
      { role: "link", name: "Sony Headphones", genericPath: "body>div>ul>li>a" },
      { role: "link", name: "Adidas Ultraboost", genericPath: "body>div>ul>li>a" },
    ] as Element[];

    const result = compressRepetitiveSiblings(elements);

    const compressed = result.filter(e => e.compressed);
    const normal = result.filter(e => !e.compressed);

    expect(compressed).toHaveLength(1);
    expect(compressed[0].name).toBe("Add to cart");
    expect(compressed[0].count).toBe(10);

    expect(normal).toHaveLength(3);
    expect(normal.map(e => e.name)).toContain("Nike Air Max");
    expect(normal.map(e => e.name)).toContain("Sony Headphones");
    expect(normal.map(e => e.name)).toContain("Adidas Ultraboost");
  });

  it("does not compress groups of 5 or fewer", () => {
    const elements = Array.from({ length: 5 }, () => ({
      role: "button", name: "Save", genericPath: "body>form>button"
    })) as Element[];
    const result = compressRepetitiveSiblings(elements);
    expect(result.every(e => !e.compressed)).toBe(true);
    expect(result).toHaveLength(5);
  });
});
