import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { SF_TOAST_WATCH_JS } from "../src/stages/generator.js";
import { toastCreated } from "../src/stages/salesforceOracles.js";

/**
 * Known gap from round 6 (U8, run 2026-11-13T22-46-34-982Z-d5e71075): Contact's "New Case" quick action
 * never opens the Case it made, so the API checks had no id for it. Its toast names it:
 * 'Case "00001159" was created.' Canary names (Zq) stand in for the org's records.
 */
describe("records a quick action made are found from their success toast", () => {
  it("the page watcher hands each 'was created' toast to the spec once", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const got: string[] = [];
      await page.exposeFunction("__tbToast", (t: string) => { got.push(t); });
      await page.addInitScript(SF_TOAST_WATCH_JS);
      await page.goto("about:blank");
      await page.setContent("<body><div id='x'></div></body>");
      await page.evaluate(() => {
        const t = document.createElement("div");
        t.className = "forceToastMessage";
        t.innerHTML = "<span>Success notification.</span>\n<span>Zq Case \"00001159\" was created.</span>";
        document.body.appendChild(t);
        const other = document.createElement("div");
        other.setAttribute("role", "status");
        other.textContent = "Saving...";
        document.body.appendChild(other);
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => { document.querySelector(".forceToastMessage")!.setAttribute("data-x", "1"); });
      await page.waitForTimeout(100);
      expect(got).toEqual(['Success notification. Zq Case "00001159" was created.']);
    } finally {
      await browser.close();
    }
  }, 30000);

  it("the toast's record is looked up by its object's name field, only when no id is known", async () => {
    const asked: string[] = [];
    const apiGet = async (p: string) => {
      asked.push(decodeURIComponent(p));
      if (p.startsWith("/sobjects/ZqCase/describe")) return { fields: [{ name: "Subject" }, { name: "CaseNumber", nameField: true }] };
      if (p.startsWith("/query")) return { records: [{ Id: "500ZQ0000000001AAA" }] };
      throw new Error("unexpected " + p);
    };
    const org = { objects: [{ api: "ZqCase", label: "Zq Case" }, { api: "Contact", label: "Contact" }] };
    const created = await toastCreated(apiGet, org,
      ['Success notification. Zq Case "O\'Brien 1" was created. Press Control + F6', 'Contact "Ivan Zq" was created.'],
      { Contact: ["003ZQ"] });
    expect(created).toEqual({ Contact: ["003ZQ"], ZqCase: ["500ZQ0000000001AAA"] });
    expect(asked).toContain("/query?q=SELECT Id FROM ZqCase WHERE CaseNumber = 'O\\'Brien 1' ORDER BY CreatedDate DESC LIMIT 1");
    expect(asked.some((a) => a.includes("Contact"))).toBe(false); // its id was already known
  });
});
