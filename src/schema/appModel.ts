import { z } from "zod";

export const Element = z.object({
  role: z.string(),
  name: z.string(),
  concept: z.string().optional(),   // e.g. "login-email", "search-box"
  testId: z.string().optional(),
  id: z.string().optional(),
});

export const PageModel = z.object({
  url: z.string(),
  title: z.string().optional(),
  concepts: z.array(z.string()),    // e.g. ["Login","Search"]
  elements: z.array(Element),
});

export const AppModel = z.object({
  baseUrl: z.string(),
  pages: z.array(PageModel),
});
export type AppModel = z.infer<typeof AppModel>;
