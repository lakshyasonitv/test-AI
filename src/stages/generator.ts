import type { IR, Step } from "../schema/ir.js";
import { resolveCode as locator } from "./targetResolver.js";
import { isAuthTriggeringStep } from "./authSettle.js";

const q = (s: string) => JSON.stringify(s);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function emitAssert(step: Step): string {
  const t = step.target!;
  switch (step.assertion) {
    case "visible":       return `  await expect(${locator(t)}).toBeVisible();`;
    case "hidden":        return `  await expect(${locator(t)}).toBeHidden();`;
    case "enabled":       return `  await expect(${locator(t)}).toBeEnabled();`;
    case "disabled":      return `  await expect(${locator(t)}).toBeDisabled();`;
    case "text_equals":   return `  await expect(${locator(t)}).toHaveText(${q(step.value ?? "")});`;
    case "text_contains": return `  await expect(${locator(t)}).toContainText(${q(step.value ?? "")});`;
    case "url_contains":  return `  await expect(page).toHaveURL(new RegExp(${q(escapeRe(step.value ?? ""))}));`;
    default: throw new Error(`Unknown assertion: ${step.assertion}`);
  }
}

// Auth-settle wait helper, inlined into the generated spec when any auth-triggering
// step is present. Mirrors the logic in authSettle.ts's waitForAuthSettle().
const AUTH_SETTLE_HELPER = `
async function waitForAuthSettle(page) {
  const startUrl = page.url();
  // Phase 1: wait for URL to change (fast path for real redirects).
  try {
    await page.waitForURL((url) => url.toString() !== startUrl, { timeout: 3000 });
    return;
  } catch {
    // URL didn't change within the short window; fall through to network idle.
  }
  // Phase 2: wait for network idle (SPA may mutate state without URL change).
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    // Ignore timeout; the test will continue and any ungrounded steps will be
    // handled by the existing truncation/retry logic.
  }
}
`;

function emitStep(step: Step, baseUrl: string): string {
  let code: string;
  switch (step.action) {
    case "navigate": {
      const u = step.target?.url ?? "/";
      const full = u.startsWith("http") ? u : baseUrl.replace(/\/$/, "") + u;
      code = `  await page.goto(${q(full)});`;
      break;
    }
    case "click":  code = `  await ${locator(step.target!)}.click();`; break;
    case "fill":   code = `  await ${locator(step.target!)}.fill(${q(step.value ?? "")});`; break;
    case "select": code = `  await ${locator(step.target!)}.selectOption(${q(step.value ?? "")});`; break;
    case "check":  code = `  await ${locator(step.target!)}.check();`; break;
    case "press":  code = `  await ${locator(step.target!)}.press(${q(step.value ?? "Enter")});`; break;
    case "wait":   code = `  await page.waitForTimeout(${Number(step.value ?? 1000)});`; break;
    case "assert": code = emitAssert(step); break;
    default: throw new Error(`Unknown action: ${(step as any).action}`);
  }

  // Append auth-settle wait after auth-triggering click/press steps.
  if (isAuthTriggeringStep(step)) {
    code += `\n  await waitForAuthSettle(page);`;
  }
  return code;
}

// Self-healing role+name locator, inlined into the generated spec (which stays self-contained
// — no deps beyond @playwright/test, so this can't be a shared import). Mirrors
// targetResolver.ts's resolveRoleWithFallback() exactly; keep both in sync if either changes.
const LOCATE_HELPER = `
async function locate(page, role, name) {
  const swap = { button: "link", link: "button" };
  const original = page.getByRole(role, { name });
  const candidates = [original];
  const alt = swap[role.toLowerCase()];
  if (alt) candidates.push(page.getByRole(alt, { name }));
  candidates.push(page.getByText(name));
  for (const c of candidates) {
    if (await c.count() === 1) return c;
  }
  return original.first();
}
`;

export function generateSpec(ir: IR): string {
  const body = ir.steps.map(s => emitStep(s, ir.meta.baseUrl)).join("\n");
  // The note can carry an arbitrary error message (multi-line JSON from an LLM 4xx, a stack,
  // ...). Flatten it to one line — a raw newline here escapes the `//` and makes the emitted
  // spec a syntax error, which silently breaks the very fallback the truncation path exists for.
  const truncNote = ir.meta.truncated
    ? `// PARTIAL: verified only up to the last grounded step — ${(ir.meta.truncationNote ?? "further steps could not be grounded").replace(/\s+/g, " ").slice(0, 200)}\n`
    : "";
  const helpers: string[] = [];
  if (body.includes("await locate(")) helpers.push(LOCATE_HELPER);
  if (body.includes("await waitForAuthSettle(")) helpers.push(AUTH_SETTLE_HELPER);
  const helper = helpers.join("\n");
  return `import { test, expect } from '@playwright/test';
${helper}
// AUTO-GENERATED from IR — do not edit by hand.
// Feature: ${ir.meta.feature} | Priority: ${ir.meta.priority}
// Source: ${ir.meta.sourcePrompt}
${truncNote}test(${q(ir.meta.title)}, async ({ page }) => {
${body}
});
`;
}
