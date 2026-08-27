/**
 * Amendment §6 — the check no metric can make.
 *
 * `irCoverage` only asks whether a `(role, name)` a PAST IR already grounded against is still
 * present. It structurally cannot detect a WORSE TEST CASE. The projection's whole saving comes
 * from dropping forms, navigation trees, buttons, headings and breadcrumbs — exactly the material
 * a model might use to propose sensible coverage. So the View can score 100% coverage while
 * producing thinner cases, and nothing in the test plan would notice.
 *
 * The answer is not another number. It is generating cases from both prompt forms and reading
 * them side by side.
 *
 * PROTOCOL, fixed in advance so the result cannot be shopped:
 *   - two runs: one just above the 70 ch/el threshold, one dense
 *   - one generation per form per run. NO RETRIES. A failure is reported as a failure; re-rolling
 *     turns a comparison into a best-of.
 *   - the two arms differ ONLY in the model block. Same plan, same system instruction, same
 *     checklist, same scope — which is why this goes through the real `toTestCases` via its
 *     `modelBlock` seam rather than rebuilding the prompt here. A replica would make every
 *     conclusion a conclusion about the replica.
 *   - cache bypassed with a unique `sourcePrompt` per generation. Verified key-only
 *     (testCases.ts:438) and never rendered into the prompt, so it cannot contaminate the arms.
 */

import { readFileSync } from "node:fs";
import { encode } from "gpt-tokenizer";
import { toLiteModel } from "../src/schema/appModel.js";
import { toTestCases } from "../src/stages/testCases.js";
import { buildView } from "./measureView.js";
import type { AppModel } from "../src/schema/appModel.js";

const tk = (s: string) => encode(s).length;

const RUNS = [
  { label: "A — just above threshold (72.6 ch/el)", dir: "runs/2026-07-28T09-42-27-474Z-4987461b" },
  { label: "B — dense, largest baseline (133.5 ch/el)", dir: "runs/2026-08-14T07-13-38-280Z-9ac0738e" },
];

/** `node ... compareCaseQuality.ts B` runs only the labels that start with the given letter, so a
 *  re-run of one arm-pair does not re-spend on the other. */
const ONLY = process.argv[2];
const SELECTED = ONLY ? RUNS.filter((r) => r.label.startsWith(ONLY)) : RUNS;

const read = (d: string, f: string) => JSON.parse(readFileSync(`${d}/${f}`, "utf8"));

/** Unique per call so the disk cache cannot serve one arm the other's batch. */
const uniqueSourcePrompt = (tag: string) => `${tag}-${Date.now()}-${Math.random()}`;

function show(cases: any[]) {
  if (!cases.length) { console.log("      (no cases)"); return; }
  cases.forEach((c, i) => {
    console.log(`      ${i + 1}. [${c.category}] ${c.title}`);
    console.log(`         priority   ${c.priority}   feature ${c.feature}   targetUrl ${c.targetUrl ?? "-"}`);
    if (c.intent) console.log(`         intent     ${c.intent}`);
    for (const s of c.steps ?? []) console.log(`           - ${s}`);
    if (c.expected) console.log(`         expected   ${c.expected}`);
    console.log();
  });
}

async function main() {
  for (const { label, dir } of SELECTED) {
    const model: AppModel = read(dir, "02-appmodel.json");
    const plan = read(dir, "01-plan.json");
    const input = read(dir, "00-input.json");

    const baselineBlock = JSON.stringify(toLiteModel(model));
    const viewBlock = buildView(model).text;

    console.log("\n" + "=".repeat(100));
    console.log(label);
    console.log(`run    ${dir.slice(5)}`);
    console.log(`url    ${input.url}`);
    console.log(`prompt ${input.prompt}`);
    console.log(`pages ${model.pages?.length}  elements ${(model.pages ?? []).reduce((n, p) => n + (p.elements?.length ?? 0), 0)}`);
    console.log(`model block: baseline ${tk(baselineBlock)} tok  ->  View ${tk(viewBlock)} tok`);
    console.log("=".repeat(100));

    for (const [arm, block] of [["BASELINE  toLiteModel JSON", baselineBlock],
                                ["PROJECTED View text", viewBlock]] as [string, string][]) {
      console.log(`\n  ---- ${arm} ----`);
      try {
        const cases = await toTestCases(plan, model, undefined, {
          sourcePrompt: uniqueSourcePrompt(arm),
          modelBlock: block,
        });
        console.log(`      ${cases.length} case(s)\n`);
        show(cases);
      } catch (err) {
        // Reported, never re-rolled.
        console.log(`      GENERATION FAILED: ${(err as Error)?.message ?? err}`);
      }
    }
  }
  console.log("\nDone. Read the cases above before any assessment.");
}

main();
