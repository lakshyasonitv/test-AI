/**
 * Shared discovery per project (D-72, PROJECT_DISCOVERY_SHARING).
 *
 * Off (the default): discovery is cached exactly as before — one global key per URL and login,
 * for APPMODEL_CACHE_TTL_MS (30 minutes).
 *
 * On: a discovery is saved under its ORGANISATION and PROJECT as well as its URL and login, and
 * every run of that project with the same URL and the same login reuses it for up to 7 days, or
 * until someone asks for a fresh one ("Discover the site again" -> options.freshDiscovery). The
 * user chose per-login sharing: two accounts can see different pages, and a test built from pages
 * its own account cannot reach fails for a reason nobody can see.
 *
 * Organisation + project in the key is also the tenancy boundary: with the flag on, one company's
 * saved discovery is never served to another, even for the same public URL (today's global key
 * does share it).
 *
 * One discovery at a time per key: when four people start runs on the same project at once, the
 * first crawls and the others wait for it and reuse its result, instead of four identical crawls
 * filling all four run slots. In-process only — fine on the single replica this runs on (the
 * credential prompt and the case gate already require that; README "Single replica").
 */

export const PROJECT_DISCOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function projectDiscoveryEnabled(): boolean {
  return process.env.PROJECT_DISCOVERY_SHARING === "true";
}

/** Who a discovery belongs to. Resolved and tenancy-checked by the run route, never by the request. */
export interface DiscoveryScope {
  organisationId: string;
  /** The project the run is filed under; null when it has none (the organisation is still the boundary). */
  projectId: string | null;
}

/** The cache key of a shared discovery: the scope in front of the site key (URL + login + strategy). */
export function projectDiscoveryKey(scope: DiscoveryScope, siteKey: string): string {
  return `project:${scope.organisationId}:${scope.projectId ?? "none"}|${siteKey}`;
}

const inflight = new Map<string, Promise<void>>();

/**
 * Wait until nobody is discovering `key`, then call `read`. If it finds nothing, claim the key
 * before returning, so a run arriving later waits for THIS one. No `await` between the last check
 * and the claim, so two waiting runs can never both claim (JavaScript runs one of them to the end
 * of this function first).
 *
 * Returns the hit, or `{ release }` — which the caller MUST call when its discovery is finished,
 * successful or not, or the next run on this key waits forever.
 */
export async function readOrClaim<T>(key: string, read: () => T | null): Promise<{ hit: T } | { release: () => void }> {
  for (let p = inflight.get(key); p; p = inflight.get(key)) await p;
  const hit = read();
  if (hit) return { hit };
  let done!: () => void;
  const p = new Promise<void>((r) => { done = r; });
  inflight.set(key, p);
  return {
    release: () => {
      if (inflight.get(key) === p) inflight.delete(key);
      done();
    },
  };
}

/** Tests only. */
export function _inflightCount(): number {
  return inflight.size;
}
