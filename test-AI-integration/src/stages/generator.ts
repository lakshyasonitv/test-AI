import type { IR, Step } from "../schema/ir.js";
import { resolveCode as locator } from "./targetResolver.js";
import { isAuthTriggeringStep } from "./authSettle.js";

const q = (s: string) => JSON.stringify(s);
const escapeRe = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function emitAssert(step: Step): string {
  const t = step.target!;
  switch (step.assertion) {
    case "visible":
      return `  await expect(${locator(t)}).toBeVisible({ timeout: 10000 });`;

    case "hidden":
      return `  await expect(${locator(t)}).toBeHidden({ timeout: 10000 });`;

    case "enabled":
      return `  await expect(${locator(t)}).toBeEnabled({ timeout: 10000 });`;

    case "disabled":
      return `  await expect(${locator(t)}).toBeDisabled({ timeout: 10000 });`;

    case "text_equals":
      return `  await expect(${locator(t)}).toHaveText(${q(step.value ?? "")}, { timeout: 10000 });`;

    case "text_contains":
      return `  await expect(${locator(t)}).toContainText(${q(step.value ?? "")}, { timeout: 10000 });`;

    case "url_contains":
      return `  await expect(page).toHaveURL(new RegExp(${q(
        escapeRe(step.value ?? "")
      )}), { timeout: 10000 });`;

    default:
      throw new Error(`Unknown assertion: ${step.assertion}`);
  }
}

// -----------------------------------------------------------------------------
// Auth settle helper
// -----------------------------------------------------------------------------

const AUTH_SETTLE_HELPER = `
async function waitForAuthSettle(page) {
  const startUrl = page.url();

  try {
    await page.waitForURL(
      url => url.toString() !== startUrl,
      { timeout: 3000 }
    );
    return;
  } catch {}

  try {
    await page.waitForLoadState("domcontentloaded", {
      timeout: 8000,
    });
  } catch {}
}
`;

// -----------------------------------------------------------------------------
// Self-healing locator helper — ARIA role → CSS fallback chain
// -----------------------------------------------------------------------------

const LOCATE_HELPER = `
async function locate(page, role, name, nth) {
  const original = page.getByRole(role, { name });
  
  // If nth is specified, use it to disambiguate duplicate elements
  if (nth !== undefined && nth !== null) {
    return original.nth(nth);
  }
  
  if (await original.count() === 1) return original;

  // CSS fallback: covers dropdown items, menu entries, and off-screen links
  // that ARIA role matching misses due to shadow DOM or collapsed state.
  const cssFallbacks = [
    'a:has-text("' + name + '")',
    'button:has-text("' + name + '")',
    '[role="menuitem"]:has-text("' + name + '")',
  ];
  for (const sel of cssFallbacks) {
    const el = page.locator(sel);
    if (await el.count() === 1) return el;
  }

  // Broadest fallback: any element containing the exact text
  const text = page.getByText(name, { exact: true });
  if (await text.count() === 1) return text;

  // Return original so Playwright gives a clear "strict mode" error
  // instead of silently returning null.
  return original;
}
`;

// -----------------------------------------------------------------------------
// Safe click helper — href-based navigation for links, interactive fallback
// -----------------------------------------------------------------------------

const SAFE_CLICK_HELPER = `
async function safeClick(page, role, name, nth) {
  const el = await locate(page, role, name, nth);

  // For <a> tags: read href and navigate directly — bypasses all
  // hover/visibility/viewport issues from collapsed dropdown menus.
  if (role.toLowerCase() === "link") {
    const href = await el.getAttribute("href").catch(() => null);
    if (href && href !== "#" && href !== "") {
      const target = new URL(href, page.url()).toString();
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15000 });
      return;
    }
  }

  // Fallback: non-link elements (buttons, menuitems, etc.)
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.waitFor({ state: "visible", timeout: 5000 }).catch(async () => {
    await el.hover({ force: true }).catch(() => {});
    await el.waitFor({ state: "visible", timeout: 3000 });
  });
  await el.hover().catch(() => {});
  await el.click({ timeout: 10000 }).catch(async () => {
    await el.click({ force: true, timeout: 5000 });
  });
}
`;

// -----------------------------------------------------------------------------
// Emit one IR step
// -----------------------------------------------------------------------------

function emitStep(step: Step, baseUrl: string): string {
  let code: string;

  // Handle preAction (e.g., hover to reveal dropdown)
  if (step.preAction) {
    const preAction = step.preAction;
    const t = preAction.target;
    if (preAction.action === 'hover') {
      code = `  await page.locator(${locator(t)}).hover();\n  await page.waitForTimeout(500); // Wait for dropdown animation\n`;
    } else if (preAction.action === 'click') {
      code = `  await safeClick(page, ${q(t.role ?? "")}, ${q(t.name ?? "")});\n  await page.waitForTimeout(500); // Wait for dropdown animation\n`;
    } else {
      code = '';
    }
  } else {
    code = '';
  }

  switch (step.action) {
    case "navigate": {
      const u = step.target?.url ?? "/";
      const full = u.startsWith("http")
        ? u
        : baseUrl.replace(/\/$/, "") + u;

      code += `  await page.goto(${q(full)}, { waitUntil: "domcontentloaded", timeout: 15000 });`;
      break;
    }

    case "click": {
      const t = step.target!;
      // Pass nth parameter if specified
      const nthParam = t.nth !== undefined ? `, ${t.nth}` : '';
      code += `  await safeClick(page, ${q(t.role ?? "")}, ${q(t.name ?? "")}${nthParam});\n  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});`;
      break;
    }

    case "fill":
      code += `  await ${locator(step.target!)}.fill(${q(step.value ?? "")}, { timeout: 10000 });`;
      break;

    case "select":
      code += `  await ${locator(step.target!)}.selectOption(${q(step.value ?? "")}, { timeout: 10000 });`;
      break;

    case "check":
      code += `  await ${locator(step.target!)}.check({ timeout: 10000 });`;
      break;

    case "press":
      code += `  await ${locator(step.target!)}.press(${q(step.value ?? "Enter")}, { timeout: 10000 });`;
      break;

    case "wait":
      code += `  await page.waitForTimeout(${Number(step.value ?? 1000)});`;
      break;

    case "assert":
      code += emitAssert(step);
      break;

    default:
      throw new Error(`Unknown action: ${(step as any).action}`);
  }

  if (isAuthTriggeringStep(step)) {
    code += `\n  await waitForAuthSettle(page);`;
  }

  return code;
}

// -----------------------------------------------------------------------------
// Generate Playwright spec
// -----------------------------------------------------------------------------

export function generateSpec(ir: IR): string {
  const body = ir.steps
    .map((step, i) => `  console.log("STEP ${i + 1}: ${step.action}");\n${emitStep(step, ir.meta.baseUrl)}`)
    .join("\n");

  const truncNote = ir.meta.truncated
    ? `// PARTIAL: verified only up to the last grounded step — ${(
        ir.meta.truncationNote ??
        "further steps could not be grounded"
      )
        .replace(/\s+/g, " ")
        .slice(0, 200)}\n`
    : "";

  const needsLocate = body.includes("await locate(") || body.includes("await safeClick(");
  const needsSafeClick = body.includes("await safeClick(");

  const needsAuthSettle = body.includes(
    "await waitForAuthSettle(page)"
  );

  const helper = [
    needsLocate ? LOCATE_HELPER : "",
    needsSafeClick ? SAFE_CLICK_HELPER : "",
    needsAuthSettle ? AUTH_SETTLE_HELPER : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const spec = `import { test, expect } from "@playwright/test";

${helper}

// AUTO-GENERATED from IR — do not edit by hand.
// Feature: ${ir.meta.feature}
// Priority: ${ir.meta.priority}
// Source: ${ir.meta.sourcePrompt}
${truncNote}
test(${q(ir.meta.title)}, async ({ page }) => {
${body}
});
`;

  // Sanitize: the LLM sometimes emits networkidle which hangs on real sites.
  return spec.replace(/"networkidle"/g, '"domcontentloaded"');
}
