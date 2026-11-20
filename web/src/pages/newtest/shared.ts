/**
 * Pure helpers for the New test page, ported one-for-one from public/app.js so both UIs accept,
 * reject and assemble the same URL. Nothing here talks to the server except `call`.
 */
import { api } from "../../lib/api";

// ------------------------------------------------------------------ server calls

/**
 * `api()` plus the one header the classic fetch wrapper adds that api.ts does not: the organisation
 * a platform admin picked (D-84), kept by the classic UI in sessionStorage under "tb-admin-org".
 * The server ignores it for anyone who is not a platform admin.
 */
export function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let org: string | null = null;
  try { org = sessionStorage.getItem("tb-admin-org"); } catch { /* storage unavailable */ }
  if (org && !headers.has("x-organisation-id")) headers.set("x-organisation-id", org);
  return api<T>(path, { ...init, headers });
}

export const jsonPost = (body: unknown): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string | null): void {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* ignore */ }
  },
};

// ------------------------------------------------------------------ the URL field

export type Scheme = "https://" | "http://";

/** Host+path only: no scheme, no surrounding whitespace, no leading slashes. */
export function stripScheme(raw: string): string {
  return String(raw ?? "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/+/, "");
}

/** The scheme a typed/pasted value carried, when it is http or https. */
export function pastedScheme(raw: string): Scheme | null {
  const m = raw.match(/^\s*([a-z][a-z0-9+.-]*):\/\//i);
  if (!m) return null;
  const s = m[1].toLowerCase();
  return s === "http" || s === "https" ? (`${s}://` as Scheme) : null;
}

/** localhost and 127.0.0.1 do not serve https. */
export const wantsHttp = (value: string): boolean => /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(value);

/**
 * What is wrong with the URL, in words the person can act on — or "" when it is fine.
 * Same wording and the same cases as the classic urlProblem().
 */
export function urlProblem(raw: string): string {
  const value = stripScheme(raw);
  if (!value) return "Enter the address of the page to test — for example example.com/cart.";

  const host = value.split(/[/?#]/)[0];
  if (!host) return "That looks like a path with no site — add the domain, like example.com/cart.";

  const bare = host.replace(/:\d+$/, "");
  const isLocal = /^(localhost|127\.0\.0\.1)$/i.test(bare);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
  if (isLocal || isIp) return "";

  if (!bare.includes(".")) return `"${host}" is missing a domain ending — did you mean ${bare}.com?`;
  if (!/^[a-z0-9.-]+$/i.test(bare) || /^[.-]|[.-]$|\.\./.test(bare)) {
    return `"${host}" is not a valid domain — use something like example.com.`;
  }
  const tld = bare.split(".").pop() ?? "";
  if (!/^[a-z]{2,}$/i.test(tld)) {
    return `"${host}" does not end in a valid domain — did you mean ${bare.split(".").slice(0, -1).join(".")}.com?`;
  }
  return "";
}

/** The classic shortProjectName: a Salesforce org's host shortened to its name plus kind. */
export function shortProjectName(name: string): string {
  const n = String(name ?? "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  const sf = /^([a-z0-9-]+?)(?:-dev-ed)?\.(?:(scratch|sandbox|develop|trailblaze)\.)?(my\.salesforce(?:-setup)?\.com|lightning\.force\.com|my\.site\.com)$/i.exec(n);
  if (!sf) return n || String(name ?? "");
  if (/^my\.site\.com$/i.test(sf[3])) return `${sf[1]} (site)`;
  const kinds: Record<string, string> = { scratch: "scratch org", sandbox: "sandbox", develop: "dev org", trailblaze: "playground" };
  const kind = kinds[(sf[2] ?? "").toLowerCase()];
  return kind ? `${sf[1]} (${kind})` : sf[1];
}

// ------------------------------------------------------------------ the quick-fill templates

export const TEMPLATES = [
  { label: "Login test", prompt: "Test the login functionality: attempt to log in with invalid credentials and verify an appropriate error is shown." },
  { label: "Homepage smoke test", prompt: "Verify the homepage loads successfully and key elements (header, navigation, main content) are visible." },
  { label: "Navigation test", prompt: "Verify the main navigation links work and lead to valid pages without errors." },
  { label: "Search test", prompt: "Test the search feature: enter a query and verify relevant results are displayed." },
  { label: "Form validation test", prompt: "Find a form on the page and verify it shows validation errors when submitted with empty required fields." },
];

// ------------------------------------------------------------------ /api/health, the parts this page reads

export interface Health {
  targetApps?: string[];
  sfApprovals?: boolean;
  salesforceOAuth?: boolean;
  sfDiscoveryCache?: boolean;
  specIntake?: boolean;
  jira?: boolean;
  projectDiscovery?: boolean;
  platformAdmins?: boolean;
  defaults?: { gateReview?: boolean; selfHeal?: boolean };
}

// ------------------------------------------------------------------ icons (public/icons.js paths)

const ICONS = {
  play: '<path d="M6 3.5v17l14-8.5z"/>',
  loader: '<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>',
};
/** The same SVG markup icons.js's icon() draws (static strings, no user input). */
export const iconSvg = (name: keyof typeof ICONS, size = 14): string =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
  + `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
