import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// TD-199: the single-result <video> is reused across runs. Swapping its <source> children does not
// reload the media; without load() the PREVIOUS run's video kept playing under a new run's result —
// both when opening another run and when a new run finished in the same tab. Checked live 2026-11-17.

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const between = (a: string, b: string) => APP.slice(APP.indexOf(a), APP.indexOf(b, APP.indexOf(a)));

describe("the result video always shows the run on screen", () => {
  it("a new video source is followed by load()", () => {
    const show = between("const vid = data?.videoUrl;", "const noVid =");
    const set = show.indexOf('resultVideoEl.innerHTML = `<source src=');
    expect(set).toBeGreaterThan(-1);
    expect(show.indexOf("resultVideoEl.load();", set)).toBeGreaterThan(set);
  });

  it("a run without a video drops the old media and poster too", () => {
    const show = between("const vid = data?.videoUrl;", "const noVid =");
    const none = show.slice(show.indexOf("} else {"));
    expect(none).toContain('resultVideoEl.removeAttribute("poster");');
    expect(none).toContain("resultVideoEl.load();");
  });

  it("clearing the result between runs unloads the video", () => {
    const hide = between("function hideSingleTestResult()", "\n}\n");
    expect(hide).toContain("resultVideoEl.load();");
    expect(hide).toContain('resultVideoEl.removeAttribute("poster");');
  });
});
