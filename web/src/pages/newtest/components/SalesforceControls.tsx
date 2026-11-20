import { SfState } from "../hooks/useSalesforce";
import { SignInCard } from "./SignInCard";

/** The "This URL is a Salesforce org" box, then (OAuth on) the "Sign in as" card. */
export function SalesforceControls({ sf }: { sf: SfState }) {
  if (!sf.flags.targetApp) return null;
  return (
    <>
      <label className="field-label" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, cursor: "pointer" }}>
        <input type="checkbox" className="lib-check" id="targetAppSalesforce" checked={sf.targetChecked}
          onChange={(e) => sf.setTargetChecked(e.target.checked)} /> This URL is a Salesforce org
      </label>
      {sf.flags.oauth && <SignInCard sf={sf} />}
    </>
  );
}
