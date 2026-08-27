import { readFileSync } from "node:fs";
import { toMicroModel, INTERACTIVE_ROLES, hiddenInputNames } from "../src/schema/appModel.js";
const m: any = JSON.parse(readFileSync("runs/2026-08-14T07-13-38-280Z-9ac0738e/02-appmodel.json", "utf8"));
const input: any = JSON.parse(readFileSync("runs/2026-08-14T07-13-38-280Z-9ac0738e/00-input.json", "utf8"));
const now = (p: any) => (p.elements ?? []).filter((e: any) => e.name?.trim() && INTERACTIVE_ROLES.has((e.role ?? "").toLowerCase()));
const pages = m.pages.map((p: any) => ({ ...p, elements: now(p) }));
const micro: any = toMicroModel({ ...m, pages }, { currentPageUrl: input.url });
const picked = micro.pages[0].url;
console.log("page picked:", picked);
const src = m.pages.find((p: any) => p.url === picked);
const hid = hiddenInputNames(src);
console.log("hidden-input names/values on THAT page:", hid.size);
console.log("elements on that page after named+interactive:", now(src).length);
console.log("  of those, hidden inputs:", now(src).filter((e: any) => e.visible === false || hid.has(String(e.name))).length);
console.log("\nthe 30 emitted, marked:");
micro.pages[0].elements.forEach((e: any, i: number) => {
  const junk = hid.has(String(e.name ?? ""));
  console.log(`  ${String(i + 1).padStart(2)}. ${junk ? "JUNK " : "     "}${e.role} "${String(e.name).slice(0, 46)}"`);
});
