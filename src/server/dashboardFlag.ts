/**
 * The app's dashboard screen (D-79): an overview at `#/dashboard` with links to a new test,
 * History, the saved suites and the most recent runs. It only READS routes that already exist
 * (`/api/runs`, `/api/suites`, `/api/projects`); there is no new API route behind it.
 *
 * ON BY DEFAULT, at the user's explicit request (2026-11-12): the dashboard should "work
 * directly", with no setting. This is a deliberate exception to platform rule 2 (new capabilities
 * default OFF), recorded in DECISIONS.md D-79. To turn it off, set DASHBOARD_ENABLED to false, 0,
 * off or no: `/api/health` then carries no `dashboard` field, app.js routes `#/dashboard` to home
 * as it routes any other unknown hash, and no dashboard link is created, so the app is what it
 * was before the dashboard existed.
 */
export function dashboardEnabled(): boolean {
  const v = (process.env.DASHBOARD_ENABLED ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(v);
}
