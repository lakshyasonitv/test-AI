import { BLOCKED_IMAGE_DESC, buildStepNarrative, describeScreenshot } from "../text";

export function CaseNarrative({ c, ir, status, tokens }: { c: any; ir: any; status: string; tokens: any }) {
  const steps = ir?.steps;
  const whatHappened = steps?.length ? buildStepNarrative(steps, status, tokens) : (c.whyItMatters || c.intent || "");
  if (!whatHappened) return null;
  const whatImage = !c.screenshotUrl ? "" : status === "blocked" ? BLOCKED_IMAGE_DESC : describeScreenshot(steps);
  return (
    <div className="case-narrative">
      <p className="case-narrative-line"><b>What happened:</b> {whatHappened}</p>
      {whatImage && <p className="case-narrative-line"><b>What the image shows:</b> {whatImage}</p>}
    </div>
  );
}
