import { describe, it, expect } from "vitest";
import { screenFlowUrls } from "../src/stages/salesforceOrgModel.js";

// Run 2026-11-10T04-44-28-274Z-0142c5f5: the request named a screen flow, discovery never opened its
// run page, and the case created a record through the plain form instead (reported incomplete).
describe("screenFlowUrls", () => {
  const org = { flows: [
    { label: "Zq New Thing Screen", api: "Zq_New_Thing_Screen", type: "screen" },
    { label: "Zq Other Screen", api: "Zq_Other_Screen", type: "screen" },
    { label: "Zq Rating Rule", api: "Zq_Rating_Rule", type: "record-triggered" },
  ] };
  const origin = "https://zq.lightning.force.com/";

  it("opens the run page of a screen flow the request names by its label", () => {
    expect(screenFlowUrls(origin, org, "Open the Zq New Thing Screen flow and enter a name"))
      .toEqual(["https://zq.lightning.force.com/flow/Zq_New_Thing_Screen"]);
  });

  it("also by its API name or its /flow/ path", () => {
    expect(screenFlowUrls(origin, org, "run Zq_Other_Screen")).toEqual(["https://zq.lightning.force.com/flow/Zq_Other_Screen"]);
    expect(screenFlowUrls(origin, org, "go to /flow/Zq_Other_Screen")).toEqual(["https://zq.lightning.force.com/flow/Zq_Other_Screen"]);
  });

  it("never a flow the request does not name, nor a record-triggered one", () => {
    expect(screenFlowUrls(origin, org, "Create a Zq Thing and check the Zq Rating Rule result")).toEqual([]);
    expect(screenFlowUrls(origin, {}, "Zq New Thing Screen")).toEqual([]);
  });
});

// Run 2026-11-10T05-00-45-973Z-f92a47fc: six record-triggered flows filled the 10-flow cap first and the
// screen flow the request named was cut. A flow the request names now sorts ahead of the cap.
describe("flowNamedIn", () => {
  it("matches a flow by its label or API name, whole words only", async () => {
    const { flowNamedIn } = await import("../src/stages/salesforceOrgModel.js");
    expect(flowNamedIn("Open the Zq New Thing Screen flow", { Label: "Zq New Thing Screen", ApiName: "Zq_New_Thing_Screen" })).toBe(true);
    expect(flowNamedIn("run Zq_New_Thing_Screen", { Label: "Other", ApiName: "Zq_New_Thing_Screen" })).toBe(true);
    expect(flowNamedIn("Open the Zq New Thing Screenplay", { Label: "Zq New Thing Screen", ApiName: "X" })).toBe(false);
    expect(flowNamedIn("", { Label: "Zq", ApiName: "Zq" })).toBe(false);
  });
});
