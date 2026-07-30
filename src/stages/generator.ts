import type { IR, Step } from "../schema/ir.js";
import { resolveCode as locator } from "./targetResolver.js";
import { isAuthTriggeringStep } from "./authSettle.js";

const q = (s: string) => JSON.stringify(s);
const escapeRe = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Comparison value for the assertions that need one. Accepts target.url for url_contains
 *  because the IR prompt's own examples put the path there; ir.ts normalizes it too, so
 *  this is belt-and-braces. Empty is never OK — see emitAssert. */
function comparisonValue(step: Step): string {
  if (step.assertion === "url_contains") return step.value ?? step.target?.url ?? "";
  return step.value ?? "";
}

function emitAssert(step: Step): string {
  const t = step.target!;

  // An empty comparison value silently turns into `toHaveURL(new RegExp(""))` or
  // `toContainText("")` — assertions that match anything and therefore verify nothing.
  // A test that always passes is worse than one that fails: it reports a green verdict
  // the user has no reason to doubt. Fail loudly instead of lying quietly.
  if (step.assertion === "url_contains" || step.assertion === "text_contains" || step.assertion === "text_equals") {
    if (!comparisonValue(step).trim()) {
      throw new Error(
        `Step ${step.id}: "${step.assertion}" has no comparison value, which would assert ` +
        `nothing at all (it matches any page). Refusing to emit a vacuous assertion.`
      );
    }
  }

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
      return `  await expect(${locator(t)}).toHaveText(${q(comparisonValue(step))}, { timeout: 10000 });`;

    case "text_contains":
      return `  await expect(${locator(t)}).toContainText(${q(comparisonValue(step))}, { timeout: 10000 });`;

    case "url_contains":
      return `  await expect(page).toHaveURL(new RegExp(${q(
        escapeRe(comparisonValue(step))
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
  code = '';
  if (step.preAction) {
    const preAction = step.preAction;
    const t = preAction.target;
    if (preAction.action === 'hover') {
      // resolveCode() already returns a full locator expression — wrapping it in
      // page.locator() would pass a Locator where a selector string is expected.
      code = `  await ${locator(t)}.hover();\n  await page.waitForTimeout(500); // Wait for dropdown animation\n`;
    } else if (preAction.action === 'click') {
      code = t.role && t.name
        ? `  await safeClick(page, ${q(t.role)}, ${q(t.name)});\n  await page.waitForTimeout(500); // Wait for dropdown animation\n`
        : `  await ${locator(t)}.click({ timeout: 10000 });\n  await page.waitForTimeout(500); // Wait for dropdown animation\n`;
    }
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
      // safeClick is the role+name path only — it calls getByRole under the hood, and
      // Playwright rejects an empty role outright ("Role must not be empty"). A target
      // carrying only text/label/placeholder/testId is legitimate (dynamic content the
      // discovery snapshot never saw), so route it through the same resolver every other
      // action uses instead of passing empty strings that silently drop the target.
      // A verified css selector wins: safeClick goes through getByRole, which cannot match
      // an element whose accessible name is empty or was derived by discovery.
      if (!t.css && t.role && t.name) {
        const nthParam = t.nth !== undefined ? `, ${t.nth}` : '';
        code += `  await safeClick(page, ${q(t.role)}, ${q(t.name)}${nthParam});`;
      } else {
        code += `  await ${locator(t)}.click({ timeout: 10000 });`;
      }
      code += `\n  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});`;
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
// Step label helper — human-readable name for test.step()
// -----------------------------------------------------------------------------

function stepLabel(step: Step, index: number, baseUrl: string): string {
  const t = step.target;
  const name = t?.name ? ` '${t.name}'` : "";
  const val = step.value ? ` '${step.value}'` : "";
  switch (step.action) {
    case "navigate": {
      const u = t?.url ?? "/";
      const full = u.startsWith("http") ? u : baseUrl.replace(/\/$/, "") + u;
      return `Navigate to ${full}`;
    }
    case "click": return `Click${name}`;
    case "fill": return `Fill${name} with${val}`;
    case "select": return `Select${val} in${name}`;
    case "check": return `Check${name}`;
    case "press": return `Press${val || " Enter"} in${name}`;
    case "wait": return `Wait ${step.value ?? 1000}ms`;
    case "assert": {
      const assertion = step.assertion ?? "visible";
      if (assertion === "text_contains") return `Assert${name} contains${val}`;
      if (assertion === "text_equals") return `Assert${name} text is${val}`;
      if (assertion === "url_contains") return `Assert URL contains${val}`;
      return `Assert${name} is ${assertion}`;
    }
    default: return `Step ${index + 1}: ${step.action}`;
  }
}

// -----------------------------------------------------------------------------
// Generate Playwright spec
// -----------------------------------------------------------------------------

/**
 * @param screenshotDir where per-step screenshots go, relative to the process CWD.
 *   REQUIRED in practice: the previous hard-coded "artifacts/" was relative to the CWD of
 *   the Playwright process (the project root), so every run and every case in a suite
 *   overwrote the same artifacts/step-N.png files. On a multi-user deployment that is a
 *   cross-user leak, since concurrent runs share one CWD.
 */
export function generateSpec(ir: IR, screenshotDir = "artifacts"): string {
  // Forward slashes and no trailing separator: this string is embedded in generated code and
  // has to be valid on Windows too, where path.join produces backslashes that would need
  // escaping inside a JS string literal.
  const shotDir = screenshotDir.replace(/\\/g, "/").replace(/\/+$/, "");

  const body = ir.steps
    .map((step, i) => {
      const label = stepLabel(step, i, ir.meta.baseUrl);
      const code = emitStep(step, ir.meta.baseUrl);
      const indented = code.split("\n").map((l) => "    " + l).join("\n");
      return `    await test.step(${q(label)}, async () => {\n${indented}\n      await page.screenshot({ path: ${q(`${shotDir}/step-${i + 1}.png`)} });\n    });`;
    })
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

${ helper }

// AUTO-GENERATED from IR — do not edit by hand.
// Feature: ${ir.meta.feature}
// Priority: ${ir.meta.priority}
// Source: ${ir.meta.sourcePrompt}
${ truncNote }
  test(${ q(ir.meta.title)
}, async ({ page }) => {
${ body }
});
`;

  // Sanitize: the LLM sometimes emits networkidle which hangs on real sites.
  return spec.replace(/"networkidle"/g, '"domcontentloaded"');
}
