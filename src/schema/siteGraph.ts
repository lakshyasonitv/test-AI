import { z } from "zod";
import { AppModel } from "./appModel.js";

export const SiteGraphPage = z.object({
  raw: z.object({
    title: z.string(),
    ariaSnapshot: z.string(),
  }),
  appModel: AppModel.optional(),
  outboundTargets: z.array(z.string()),
  visited: z.boolean(),
});
export type SiteGraphPage = z.infer<typeof SiteGraphPage>;

export const SiteGraph = z.object({
  entryUrl: z.string().url(),
  pages: z.record(z.string().url(), SiteGraphPage),
  truncatedByScope: z.boolean(),
});
export type SiteGraph = z.infer<typeof SiteGraph>;
