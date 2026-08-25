import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AppModel } from "../src/schema/appModel.js";
import type { IR } from "../src/schema/ir.js";

/**
 * Re-grounding an edited case.
 *
 * The browser walk is mocked — `refreshPageModel` is the single seam between this module and
 * Chromium, so replacing it is what makes these tests run in milliseconds. **`groundingError` is
 * NOT mocked**: it is the real grounder, and the assertions below are about what it actually does
 * to a target (re-attaching `css`, correcting a name, refusing an element that is not there).
 * Mocking it would leave nothing worth testing.
 */

const refreshPageModel = vi.fn<(m: AppModel, prefix: any[], creds?: any) => Promise<AppModel>>();

vi.mock("../src/stages/liveExtend.js", async (orig) => ({
  ...(await orig<any>()),
  refreshPageModel: (...a: any[]) => (refreshPageModel as any)(...a),
}));

const { regroundEditedIr } = await import("../src/stages/caseEdit.js");

/** A page the walk "discovers", carrying the deterministic identity grounding copies onto a
 *  target. `css` is the field that proves grounding actually happened. */
const pageWith = (url: string, elements: any[]): AppModel => ({
  baseUrl: "https://app.example.com",
  pages: [{ url, title: "t", concepts: [], elements }],
});

const LOGIN_PAGE = pageWith("https://app.example.com/login", [
  { role: "textbox", name: "Email", css: "#email", visible: true },
  { role: "button", name: "Log In", css: "#login-btn", visible: true },
]);

/** An edited IR: step 3's target was retyped, so it arrives with no css — exactly the shape
 *  `stepText.parseIrStep` produces for a changed row. */
const editedIr = (targetName = "Log In"): IR => ({
  meta: {
    feature: "auth", title: "Sign in", priority: "medium",
    sourcePrompt: "p", baseUrl: "https://app.example.com",
  },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/login" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Email", css: "#email" }, value: "${env:TEST_USERNAME}" },
    { id: "s3", action: "click", target: { role: "button", name: targetName } },
  ],
});

beforeEach(() => {
  refreshPageModel.mockReset();
  refreshPageModel.mockResolvedValue(LOGIN_PAGE);
});

describe("the fast path — an edit that needs no verification must not open a browser", () => {
  it("does nothing at all when no target changed", async () => {
    const ir = editedIr();
    const res = await regroundEditedIr(ir, [], {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(refreshPageModel).not.toHaveBeenCalled();
    expect(res.snapshots).toBe(0);
    expect(res.usage.calls).toBe(0);
    // Returned untouched — not re-derived, so the credential reference survives verbatim.
    expect(res.ir).toBe(ir);
    expect(res.ir.steps[1].value).toBe("${env:TEST_USERNAME}");
  });
});

describe("re-grounding — the browser walk and what it puts back", () => {
  it("walks to the page the edited step acts on", async () => {
    await regroundEditedIr(editedIr(), [2], {});
    expect(refreshPageModel).toHaveBeenCalledTimes(1);
    // The prefix is the steps BEFORE the edited one — you cannot check step 3 without running 1-2.
    const prefix = refreshPageModel.mock.calls[0][1];
    expect(prefix.map((s: any) => s.id)).toEqual(["s1", "s2"]);
  });

  it("re-attaches the grounding the edit stripped", async () => {
    const res = await regroundEditedIr(editedIr("Log In"), [2], {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // css came from the discovered element — this is the whole point of re-grounding.
    expect(res.ir.steps[2].target?.css).toBe("#login-btn");
  });

  it("leaves an untouched step's grounding and credential reference exactly as they were", async () => {
    const res = await regroundEditedIr(editedIr(), [2], {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ir.steps[1].target?.css).toBe("#email");
    expect(res.ir.steps[1].value).toBe("${env:TEST_USERNAME}");
  });

  it("blames the right step when the element is not on the page", async () => {
    const res = await regroundEditedIr(editedIr("Nonexistent Button"), [2], {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stepIndex).toBe(2);
    expect(res.stepId).toBe("s3");
    expect(res.message).toBeTruthy();
  });

  it("blames the step it could not reach when the walk itself fails", async () => {
    refreshPageModel.mockRejectedValue(new Error("login rejected"));
    const res = await regroundEditedIr(editedIr(), [2], {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.stepId).toBe("s3");
    expect(res.message).toContain("could not reach step s3");
    // and it says why, rather than just failing
    expect(res.message).toContain("login rejected");
  });

  it("shares one walk between two edits that land on the same page", async () => {
    const ir = editedIr();
    ir.steps.push({ id: "s4", action: "click", target: { role: "button", name: "Log In" } });
    await regroundEditedIr(ir, [2, 2], {});
    expect(refreshPageModel).toHaveBeenCalledTimes(1);
  });

  it("respects the walk budget rather than launching a browser per step", async () => {
    process.env.MAX_LIVE_EXTENSIONS = "2";
    const ir = editedIr();
    for (let i = 4; i <= 9; i++) {
      ir.steps.push({ id: `s${i}`, action: "click", target: { role: "button", name: "Log In" } });
    }
    await regroundEditedIr(ir, [2, 3, 4, 5, 6], {});
    expect(refreshPageModel.mock.calls.length).toBeLessThanOrEqual(2);
    delete process.env.MAX_LIVE_EXTENSIONS;
  });
});

describe("progress — the UI has to be able to say which step is being verified", () => {
  it("reports each step as it is walked, with a total to count against", async () => {
    const seen: any[] = [];
    await regroundEditedIr(editedIr(), [2], { onProgress: (p) => seen.push(p) });
    const walking = seen.filter((p) => p.phase === "walking");
    expect(walking.length).toBe(1);
    expect(walking[0]).toMatchObject({ stepIndex: 2, stepId: "s3", total: 1 });
    // and a final grounding phase, so the UI can distinguish "walking" from "checking"
    expect(seen.some((p) => p.phase === "grounding")).toBe(true);
  });
});

describe("cancellation — stopping must write nothing and leak nothing", () => {
  it("stops before the first browser launch when cancelled up front", async () => {
    const res = await regroundEditedIr(editedIr(), [2], { shouldCancel: () => true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.cancelled).toBe(true);
    expect(refreshPageModel).not.toHaveBeenCalled();
    expect(res.snapshots).toBe(0);
  });

  it("stops mid-walk, and does not start another browser after the signal", async () => {
    const ir = editedIr();
    for (let i = 4; i <= 6; i++) {
      ir.steps.push({ id: `s${i}`, action: "click", target: { role: "button", name: "Log In" } });
    }
    let calls = 0;
    refreshPageModel.mockImplementation(async () => { calls++; return LOGIN_PAGE; });
    // Cancel once the first snapshot has been taken.
    const res = await regroundEditedIr(ir, [2, 3, 4, 5], { shouldCancel: () => calls >= 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.cancelled).toBe(true);
    // The in-flight one finished (and closed its own browser); no further one was started.
    expect(calls).toBe(1);
  });

  it("reports cancellation as cancellation, not as a failure the user caused", async () => {
    const res = await regroundEditedIr(editedIr(), [2], { shouldCancel: () => true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("cancelled");
    expect(res.message).toContain("nothing was written");
  });

  it("a cancelled re-ground returns no IR at all, so there is nothing a caller could save", async () => {
    const res = await regroundEditedIr(editedIr(), [2], { shouldCancel: () => true });
    expect(res.ok).toBe(false);
    expect((res as any).ir).toBeUndefined();
  });
});
