/**
 * The app's link back to the marketing landing page (D-76), which is hosted apart from the app
 * (`landing/`, e.g. on Hostinger) and links INTO the app with plain hrefs.
 *
 * LANDING_URL is both the setting and the flag: unset, empty or not an http(s) address means OFF,
 * `/api/health` carries no `landingUrl` field and app.js builds no link, so the UI is exactly what
 * it was before. Only http and https are accepted, so a mistyped or hostile value (a
 * `javascript:` URL) can never become a clickable link in the app's top bar.
 */
export function landingUrl(): string | null {
  const raw = (process.env.LANDING_URL ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.href;
}
