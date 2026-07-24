import { z } from "zod";

export const CrawlDirectiveSchema = z.object({
  entryUrl: z.string().url(),
  scope: z.object({
    // Constrain crawl scope to the same origin as entryUrl by default.
    sameOriginOnly: z.boolean().default(true),
    maxDepth: z.number().int().positive().default(3),
    maxPages: z.number().int().positive().default(25),
  }),
  intentHints: z.array(z.string()), // derived from existing plan steps, verbatim strings
});

export type CrawlDirective = z.infer<typeof CrawlDirectiveSchema>;
