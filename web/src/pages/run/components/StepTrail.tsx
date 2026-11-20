import { STEP_TRAIL_NOTE, readableStep, reportStepsOf, stepOutcomes } from "../text";

/** The step trail (D-81): green up to where the run got, red from the step it failed on. */
export function StepTrail({ c, ir, status, raw, tokens, strict }: { c: any; ir: any; status: string; raw: any; tokens: any; strict: boolean }) {
  const steps: any[] | undefined = ir?.steps;
  if (!steps?.length) return null;
  const reportSteps = reportStepsOf(raw, ir?.meta?.title, strict);
  const outcomes = stepOutcomes(steps, reportSteps, c, status);
  if (!outcomes) return null;
  const failedIdx = outcomes.indexOf("failed");
  const errLine = failedIdx >= 0
    ? String(reportSteps?.[failedIdx]?.error?.message ?? c?.error ?? "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? ""
    : "";
  const cut = (status === "truncated" || status === "truncated_no_assertion") && failedIdx < 0;
  const ran = outcomes.filter((o) => o === "ok").length;
  return (
    <div data-step-trail="">
      <p data-step-head=""><b>Steps</b> <span>{ran} of {steps.length} done{failedIdx >= 0 ? `, failed at step ${failedIdx + 1}` : cut ? ", then stopped" : ""}</span></p>
      <ol>
        {steps.map((s, i) => (
          <li key={i} data-step={outcomes[i]}>
            <span data-step-n="">{i + 1}</span>
            <span data-step-text="">{readableStep(s, tokens)}{outcomes[i] === "failed" && errLine && <small>{errLine}</small>}</span>
            <span data-step-note="">{STEP_TRAIL_NOTE[outcomes[i]]}</span>
          </li>
        ))}
        {cut && (
          <li data-step="failed">
            <span data-step-n="">{steps.length + 1}</span>
            <span data-step-text="">The rest of the test could not be built, so it never ran{ir?.meta?.truncationNote && <small>{ir.meta.truncationNote}</small>}</span>
            <span data-step-note="">Stopped here</span>
          </li>
        )}
      </ol>
    </div>
  );
}
