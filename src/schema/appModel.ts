import { z } from "zod";

export const Element = z.object({
  role: z.string(),
  name: z.string(),
  concept: z.string().optional(),   // e.g. "login-email", "search-box"
  testId: z.string().optional(),
  id: z.string().optional(),
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  containerRole: z.string().optional(),
  containerName: z.string().optional(),
  pageSection: z.string().optional(), // "main", "nav", "header", "footer", "dialog"
  path: z.array(z.string()).optional(), // ["body", "main", "form", "button"]
  order: z.number().optional(),
});
export type Element = z.infer<typeof Element>;

export const PageModel = z.object({
  url: z.string(),
  title: z.string().optional(),
  concepts: z.array(z.string()),    // e.g. ["Login","Search"]
  elements: z.array(Element),
});
export type PageModel = z.infer<typeof PageModel>;

export const AppModel = z.object({
  baseUrl: z.string(),
  pages: z.array(PageModel),
});
export type AppModel = z.infer<typeof AppModel>;

/** Strip elements to role/name/concept only — reduces prompt size 70-90%. */
export function toLiteModel(model: AppModel): AppModel {
  return {
    ...model,
    pages: model.pages.map(p => ({
      url: p.url,
      title: p.title,
      concepts: p.concepts,
      elements: p.elements.map(({ role, name, concept }) => ({ role, name, concept })),
    })),
  };
}

/** Keep only elements whose concept is in the given set (or has no concept — structural). */
export function filterByConcepts(model: AppModel, concepts: string[]): AppModel {
  const set = new Set(concepts);
  return {
    ...model,
    pages: model.pages.map(p => ({
      ...p,
      elements: p.elements.filter(e => !e.concept || set.has(e.concept)),
    })),
  };
}
