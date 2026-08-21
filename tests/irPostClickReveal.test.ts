import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// Regression: dynamic in-page modal forms were never filled correctly.
//
// A modal opened by a button click doesn't change the URL, so its fields are absent from the
// AppModel and the model invents names for them. live-extend — the mechanism that exists to
// discover exactly this — only fires when groundingError reports a MISS. So when an invented name
// happens to COLLIDE with real page chrome, the step grounds clean, live-extend never runs, and a
// test that fills the wrong control ships as a pass.
//
// Confirmed against run 2026-08-10T11-15-46-262Z-1279794e (assettrack-web.onrender.com): the
// "fill the ticket Title" step ground onto the page header's asset-search box, and the "submit"
// step onto an unrelated existing ticket's "open" status badge. Its sibling case-1 in run
// a5d729b1 guessed a name that MISSED, so live-extend fired and its IR targets the modal's real
// fields — same run, same modal, opposite outcomes, decided purely by whether the hallucinated
// name happened to collide.

const HOST = "https://post-click-reveal.example";

// What discovery can see before the modal opens: page chrome only. The header search box is the
// decoy — a real textbox, on the real page, with nothing to do with the ticket form.
const CHROME = [
  { role: "link", name: "TicketsTickets" },
  { role: "textbox", name: "Search assets by serial or name..." },
  { role: "button", name: "Raise Ticket" },
];
// What a live re-snapshot sees once the modal is open: the chrome is still there (page furniture
// doesn't vanish behind a dialog — this is exactly why re-grounding alone can't fix the bug),
// plus the modal's own fields.
const MODAL_FIELDS = [
  { role: "textbox", name: "E.g., Laptop screen flickering" },
  { role: "textbox", name: "Provide more details..." },
  { role: "button", name: "Submit Ticket" },
];

const page = (elements: any[]) => ({
  url: `${HOST}/tickets`, title: "Tickets", concepts: ["Ticketing"], elements,
});
const appModel: any = { baseUrl: HOST, pages: [page(CHROME)] };
const refreshedModel: any = { baseUrl: HOST, pages: [page([...CHROME, ...MODAL_FIELDS])] };

const irWith = (fillTarget: any) => ({
  meta: { feature: "Ticketing", title: "Raise a ticket", priority: "high", sourcePrompt: "p", baseUrl: HOST },
  steps: [
    { id: "s1", action: "click", target: { role: "link", name: "TicketsTickets" } },
    { id: "s2", action: "click", target: { role: "button", name: "Raise Ticket" } },
    { id: "s3", action: "fill", target: fillTarget, value: "test data" },
    { id: "s4", action: "assert", target: { role: "link", name: "TicketsTickets" }, assertion: "visible" },
  ],
});
// The bug: grounds clean against the header search box.
const COLLIDING_IR = irWith({ role: "textbox", name: "Search assets by serial or name..." });
// What the model should produce once it can actually see the modal.
const CORRECT_IR = irWith({ role: "textbox", name: "E.g., Laptop screen flickering" });

const { geminiMock, refreshMock, extendMock } = vi.hoisted(() => ({
  geminiMock: vi.fn(),
  refreshMock: vi.fn(),
  extendMock: vi.fn(),
}));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));
vi.mock("../src/stages/liveExtend.js", () => ({
  extendAppModel: extendMock,
  refreshPageModel: refreshMock,
  groundTerminalTextAssertion: vi.fn(async (ir: any) => ({ ir, grounded: false, corrected: false })),
  isPureTextAssertion: () => false,
}));

const { toIR, postClickRevealIndex } = await import("../src/stages/ir.js");

const testCase: any = {
  title: "Raise a ticket", priority: "high", feature: "Ticketing",
  steps: ["Click 'Tickets'", "Click 'Raise Ticket'", "Fill the ticket form", "Verify the page"],
  expected: "The ticket form is filled", category: "valid", generatedFrom: "upfront",
};
// toIR disk-caches on a hash of (testCase, sourcePrompt, appModel, creds). A static prompt would
// hit a previous run's entry and never call gemini at all, making every assertion below vacuous —
// same discipline irSystemPrompt.test.ts documents.
const uniquePrompt = () => `raise a ticket ${Date.now()}-${Math.random()}`;

const reply = (ir: any) => ({
  content: JSON.stringify(ir),
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

beforeEach(() => {
  geminiMock.mockReset();
  refreshMock.mockReset();
  extendMock.mockReset();
  // Default: live-extend learns nothing new, so a grounding MISS stays a miss. Tests that care
  // about the extend path override this.
  extendMock.mockImplementation(async (m: any) => m);
});

describe("toIR — post-click reveal check", () => {
  it("rejects a fill that ground onto pre-existing chrome, and re-prompts naming the revealed fields", async () => {
    geminiMock
      .mockResolvedValueOnce(reply(COLLIDING_IR))
      .mockResolvedValueOnce(reply(CORRECT_IR));
    refreshMock.mockResolvedValue(refreshedModel);

    const { ir } = await toIR(testCase, appModel, uniquePrompt(), `${HOST}/tickets`);

    // The first IR ground clean against the model — without this check it would have shipped.
    expect(geminiMock).toHaveBeenCalledTimes(2);
    // The correction must NAME the fields the click revealed, or the model has nothing to act on.
    const secondPrompt = geminiMock.mock.calls[1][0] as string;
    expect(secondPrompt).toContain("E.g., Laptop screen flickering");
    expect(secondPrompt).toContain("Provide more details...");
    // And the run ends on the modal's real field, not the header search box.
    expect(ir.steps[2].target!.name).toBe("E.g., Laptop screen flickering");
  });

  // Load-bearing, not bookkeeping: the retry prompt is built from the CURRENT model, so if the
  // refresh result were discarded the correction would name fields the model cannot see, the
  // model would target one anyway, grounding would MISS, and a live-extend hop would be spent
  // rediscovering what had just been discovered.
  it("keeps the refreshed model, so the revealed fields are in scope for later steps", async () => {
    geminiMock
      .mockResolvedValueOnce(reply(COLLIDING_IR))
      .mockResolvedValueOnce(reply(CORRECT_IR));
    refreshMock.mockResolvedValue(refreshedModel);

    const { updatedAppModel } = await toIR(testCase, appModel, uniquePrompt(), `${HOST}/tickets`);

    const names = updatedAppModel.pages.flatMap((p: any) => p.elements).map((e: any) => e.name);
    expect(names).toContain("E.g., Laptop screen flickering");
  });

  // No modal opened — the re-snapshot reveals nothing fillable, so there is nothing to redirect
  // the step to and a correction would name nothing. Must accept, unchanged, in ONE attempt.
  it("accepts the IR unchanged when the click reveals nothing fillable", async () => {
    geminiMock.mockResolvedValue(reply(COLLIDING_IR));
    refreshMock.mockResolvedValue(appModel); // identical — nothing new appeared

    const { ir } = await toIR(testCase, appModel, uniquePrompt(), `${HOST}/tickets`);

    expect(geminiMock).toHaveBeenCalledTimes(1);
    expect(ir.steps[2].target!.name).toBe("Search assets by serial or name...");
  });

  // The division of labour, pinned. When the model names a field it couldn't see, that name
  // MISSES grounding, so the pre-existing live-extend path owns it and this check never runs —
  // which is precisely why case-1 of run a5d729b1 was already correct while its sibling case-0
  // was broken. This check exists only for the collision case live-extend structurally cannot
  // see. (It also means no "unless the target is a revealed field" guard is needed inside the
  // check: such a target can never reach it.)
  it("leaves a correctly-named revealed field to the existing live-extend path", async () => {
    geminiMock.mockResolvedValue(reply(CORRECT_IR));
    extendMock.mockResolvedValue(refreshedModel); // live-extend discovers the modal, as it did for case-1
    refreshMock.mockResolvedValue(refreshedModel);

    const { ir } = await toIR(testCase, appModel, uniquePrompt(), `${HOST}/tickets`);

    // One generation: grounding missed, live-extend fixed the model, the SAME IR re-ground.
    expect(geminiMock).toHaveBeenCalledTimes(1);
    expect(extendMock).toHaveBeenCalled();
    expect(ir.steps[2].target!.name).toBe("E.g., Laptop screen flickering");
  });

  // A replay can fail for reasons unrelated to this step (site flakiness, a login needing
  // different credentials). Best-effort, exactly like groundTerminalTextAssertion: leave the IR
  // alone rather than failing the whole run.
  it("leaves the IR alone when the replay throws", async () => {
    geminiMock.mockResolvedValue(reply(COLLIDING_IR));
    refreshMock.mockRejectedValue(new Error("browser launch failed"));

    const { ir } = await toIR(testCase, appModel, uniquePrompt(), `${HOST}/tickets`);

    expect(geminiMock).toHaveBeenCalledTimes(1);
    expect(ir.steps[2].target!.name).toBe("Search assets by serial or name...");
  });

  // The check costs a browser launch, and bounding it to one firing is also what caps its only
  // real false-positive risk (a click that reveals fields where the step legitimately targets a
  // pre-existing one) at a single wasted attempt.
  it("fires at most once per toIR call", async () => {
    geminiMock.mockResolvedValue(reply(COLLIDING_IR)); // never corrects — would loop if unbounded
    refreshMock.mockResolvedValue(refreshedModel);

    await toIR(testCase, appModel, uniquePrompt(), `${HOST}/tickets`);

    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});

// Replay against the artifacts of the real runs this fix came from — the same zero-cost
// verification the navigate-URL guard used. These read saved JSON off disk rather than
// reconstructing a fixture by hand, so they can't drift from what actually happened.
describe("postClickRevealIndex — replayed against the real saved runs", () => {
  const load = (p: string) => {
    const raw = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
    return raw.ir ?? raw; // run-level 04-ir.json wraps { ir, updatedAppModel }; case-level doesn't
  };

  it("flags s10 of the run that shipped the broken ticket test", () => {
    const ir = load("../runs/2026-08-10T11-15-46-262Z-1279794e/04-ir.json");
    const index = postClickRevealIndex(ir);
    // s10 — `fill textbox "Search assets by serial or name..."`, the header search box that
    // was filled instead of the modal's Title field.
    expect(ir.steps[index].id).toBe("s10");
    expect(ir.steps[index].target.name).toBe("Search assets by serial or name...");
    // And the step before it is the click that opened the modal.
    expect(ir.steps[index - 1].id).toBe("s9"); // the 3s wait; s8 is the click
    expect(ir.steps.find((s: any) => s.id === "s8").target.name).toBe("Raise Ticket");
  });

  // The sibling case that was ALREADY correct. The trigger still fires on it (same step shape) —
  // that's fine and expected: what matters is that toIR never reaches the check for this IR,
  // because its target misses grounding and live-extend handles it (pinned in the test above).
  // This asserts the trigger points at the right step, i.e. it isn't firing somewhere arbitrary.
  it("points at the modal's real Title field in the case that was already correct", () => {
    const ir = load("../runs/2026-08-10T10-18-49-077Z-a5d729b1/cases/case-1/04-ir.json");
    const index = postClickRevealIndex(ir);
    expect(ir.steps[index].target.name).toBe("E.g., Laptop screen flickering");
    expect(ir.steps[index - 1].target.name).toBe("Raise Ticket");
  });
});
