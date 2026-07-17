import type { IR, Step } from "../schema/ir.js";
import { resolveCode as locator } from "./targetResolver.js";

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

function emitStep(step: Step, baseUrl: string): string {
  switch (step.action) {
    case "navigate": {
      const u = step.target?.url ?? "/";
      const full = u.startsWith("http") ? u : baseUrl.replace(/\/$/, "") + u;
      return `  await page.goto(${q(full)});`;
    }
    case "click":  return `  await ${locator(step.target!)}.click();`;
    case "fill":   return `  await ${locator(step.target!)}.fill(${q(step.value ?? "")});`;
    case "select": return `  await ${locator(step.target!)}.selectOption(${q(step.value ?? "")});`;
    case "check":  return `  await ${locator(step.target!)}.check();`;
    case "press":  return `  await ${locator(step.target!)}.press(${q(step.value ?? "Enter")});`;
    case "wait":   return `  await page.waitForTimeout(${Number(step.value ?? 1000)});`;
    case "assert": return emitAssert(step);
    default: throw new Error(`Unknown action: ${(step as any).action}`);
  }
}

export function generateSpec(ir: IR): string {
  const body = ir.steps.map(s => emitStep(s, ir.meta.baseUrl)).join("\n");
  // The note can carry an arbitrary error message (multi-line JSON from an LLM 4xx, a stack,
  // ...). Flatten it to one line — a raw newline here escapes the `//` and makes the emitted
  // spec a syntax error, which silently breaks the very fallback the truncation path exists for.
  const truncNote = ir.meta.truncated
    ? `// PARTIAL: verified only up to the last grounded step — ${(ir.meta.truncationNote ?? "further steps could not be grounded").replace(/\s+/g, " ").slice(0, 200)}\n`
    : "";
  return `import { test, expect } from '@playwright/test';

// AUTO-GENERATED from IR — do not edit by hand.
// Feature: ${ir.meta.feature} | Priority: ${ir.meta.priority}
// Source: ${ir.meta.sourcePrompt}
${truncNote}test(${q(ir.meta.title)}, async ({ page }) => {
${body}
});
`;
}
