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

    const system = `You analyze a web page for test generation. Map raw accessibility elements to meaningful concepts (Login, Search, Cart, Checkout, Profile, ...). Output JSON only.`;
    const user =
`Base URL: ${url}
Page title: ${title}
Accessibility snapshot:
${aria}

Return ONLY JSON:
{ "baseUrl": string,
  "pages": [ { "url": string, "title": string, "concepts": string[],
    "elements": [ { "role": string, "name": string, "concept": string } ] } ] }`;

    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await gemini(user, { systemInstruction: system, json: true, model: process.env.GEMINI_MODEL_LITE });
      try {
        const result = AppModel.safeParse(parseJson(raw));
        if (result.success) {
          cacheSet(url, result.data);
          return result.data;
        }
        lastErr = result.error.message;
      } catch (err: any) {
        lastErr = err?.message ?? String(err);
      }
    }
    throw new Error(`Application model failed schema validation after retry: ${lastErr}`);
  } finally {
    await browser.close();
  }
}
