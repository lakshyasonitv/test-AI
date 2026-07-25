import type { Plan } from "./planner.js";
import { CrawlDirectiveSchema, type CrawlDirective } from "../schema/crawlDirective.js";

/**
 * Trivial pure function that maps existing Planner output into a CrawlDirective instance.
 * No I/O, no LLM calls, no browser interaction.
 */
export function buildCrawlDirective(plan: Plan, entryUrl: string): CrawlDirective {
  return CrawlDirectiveSchema.parse({
    entryUrl,
    scope: {
      sameOriginOnly: true,
      maxDepth: 3,
      maxPages: 25,
    },
    intentHints: plan.steps,
  });
}
