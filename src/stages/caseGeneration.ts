import type { Plan } from "./planner.js";
import type { AppModel } from "../schema/appModel.js";
import type { SpecModel } from "../schema/spec.js";
import { toTestCases, type TestCase, type ExtendContext, type GenerationOptions } from "./testCases.js";
import { proTestCases } from "./proTestCases.js";

/**
 * The router between the two case generators — the ONLY place that chooses.
 *
 *   testCases.ts      the standard generator. Never edited for Pro.
 *   proTestCases.ts   Pro's generator, steered by the user's confirmed requirements spec.
 *
 * A spec present means Pro; absent means the standard generator, called with EXACTLY the
 * arguments it would have received before Pro existed (the `spec` key is stripped, not passed as
 * undefined), so its prompt and cache key are untouched — tests/testCasesNoChange.test.ts.
 *
 * Errors are never caught here. A Pro failure fails the run; falling back to toTestCases would
 * hand a user who uploaded a document a suite that silently ignores it.
 */

export type RoutedGenerationOptions = GenerationOptions & { spec?: SpecModel };

export async function generateCases(
  plan: Plan, appModel: AppModel, extend?: ExtendContext, opts: RoutedGenerationOptions = {},
): Promise<TestCase[]> {
  const { spec, ...rest } = opts;
  if (spec) return proTestCases(plan, appModel, extend, { ...rest, spec });
  return toTestCases(plan, appModel, extend, rest);
}

/**
 * The generator to inject into the case-selection gate for this run. The gate calls its generator
 * once per round, so a Pro run must hand it a generator that already carries the spec — otherwise
 * round 2 (the user's "not satisfied") would produce cases that had forgotten the document.
 * Without a spec this returns `toTestCases` itself, so a standard run's gate is unchanged.
 */
export function generatorFor(spec: SpecModel | undefined): typeof toTestCases {
  if (!spec) return toTestCases;
  return (plan, appModel, extend, opts = {}) => proTestCases(plan, appModel, extend, { ...opts, spec });
}
