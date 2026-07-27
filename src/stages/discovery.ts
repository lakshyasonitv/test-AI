import { chromium } from "playwright";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import { AppModel } from "../schema/appModel.js";
import { cacheGet, cacheSet } from "../kb/cache.js";

export async function discover(url: string): Promise<AppModel> {
  const cached = cacheGet(url);
  if (cached) return cached;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Fail fast on a dead entry URL. Without this, a 404/500 page becomes a valid-looking
    // AppModel and the downstream LLMs hallucinate a UI on top of an error page (seen in
    // practice: a /login that 404s produced a fictional login-form test). Catching it here
    // gives a clear message and skips wasted LLM calls. Soft 404s (200 + "not found" body)
    // are caught later by the grounding guard, not here.
    const status = response?.status() ?? 0;
    if (!response || status >= 400) {
      throw new Error(
        `Discovery aborted: ${url} returned HTTP ${status || "no response"}. ` +
        `The entry URL must be a reachable page — check the URL and that the route exists.`
      );
    }

    const aria = await page.locator("body").ariaSnapshot();
    const title = await page.title();
    const screenshotBase64 = (await page.screenshot()).toString("base64");

    const model = await modelFromAria(url, title, aria, screenshotBase64);
    cacheSet(url, model);
    return model;
  } finally {
    await browser.close();
  }
}

/**
 * Turn an accessibility snapshot of a single page into an AppModel via the LLM. Shared by
 * discover() (fresh page load) and the live-replay extender (a page reached only after
 * replaying a login/prefix), so both label pages with the exact same anti-hallucination
 * prompt. Retries once on schema-validation failure, same as the original discovery loop.
 *
 * screenshotBase64 is optional and, when given, rides the SAME call (Gemini is natively
 * multimodal) — it does not add a request. It exists to improve LABELING of elements that
 * are already in the aria snapshot (disambiguate icon-only buttons, tell apart multiple
 * same-named controls via visual context) — never to add elements the snapshot doesn't
 * contain. The grounding guard downstream (ir.ts's groundingError) and everything built on
 * it assumes every element traces to the real snapshot; vision must not become a second,
 * looser path to inventing one.
 */
export async function modelFromAria(url: string, title: string, aria: string, screenshotBase64?: string): Promise<AppModel> {
  const system =
`You are a QA UI Discovery Engine.

Analyze the provided accessibility snapshot and build a structured application model.

Rules:
- The accessibility snapshot is the only source of truth.
- If a screenshot is provided, use it only to understand elements already present in the accessibility snapshot.
- Never invent pages, elements, roles, accessible names, or concepts.
- Extract only information directly observable from the accessibility snapshot.
- Extract all meaningful interactive elements (buttons, links, textboxes, checkboxes, radios, comboboxes, menus, tabs, searchboxes, switches, etc.).
- Ignore decorative or purely structural elements unless they help identify the page.
- Use ARIA roles exactly as provided.
- Use accessible names exactly as provided, preserving capitalization and spacing.
- If an element has no accessible name, return an empty string. Never invent one.
- Infer page concepts only when clearly supported by the accessibility snapshot. Do not infer concepts from the URL or page title alone.
- Assign an element concept only when it clearly belongs to one of the page concepts; otherwise omit the concept property.
- Do not return duplicate elements with the same role and accessible name.

Return ONLY valid JSON.

Format:
{
  "baseUrl": string,
  "pages": [
    {
      "url": string,
      "title": string,
      "concepts": string[],
      "elements": [
        {
          "role": string,
          "name": string,
          "concept": string
        }
      ]
    }
  ]
}`;
  const user =
`Base URL: ${url}
Page title: ${title}
Accessibility snapshot:
${aria}
${screenshotBase64 ? "\nA screenshot of this exact page is attached — use it only to label the snapshot's elements more accurately, per the rules above." : ""}

Return ONLY JSON:
{ "baseUrl": string,
  "pages": [ { "url": string, "title": string, "concepts": string[],
    "elements": [ { "role": string, "name": string, "concept": string } ] } ] }`;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gemini(user, {
      systemInstruction: system, json: true, model: process.env.GEMINI_MODEL_LITE,
      imageBase64: screenshotBase64, imageMime: "image/png",
    });
    try {
      const result = AppModel.safeParse(parseJson(raw));
      if (result.success) return result.data;
      lastErr = result.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Application model failed schema validation after retry: ${lastErr}`);
}
