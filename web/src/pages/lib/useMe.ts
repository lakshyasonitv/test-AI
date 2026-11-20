import { useEffect, useState } from "react";
import { api, session } from "../../api";

/**
 * Who is looking, for HIDING controls only — the server enforces every action regardless.
 *
 * Mirrors the classic UI exactly (public/app.js): `required` comes from GET /api/auth/config, the
 * role from GET /api/auth/me, and /me is only asked when sign-in is required and a session exists
 * (refreshIdentity). With sign-in off the role stays null and every gate below passes through its
 * `!required ||` half — the server hands that synthetic local user `owner` (CLAUDE.md rule 7).
 *
 * `platformModel` is /api/health's `platformAdmins` flag, which the classic UI reads the same way
 * (it gates the "Who can see this project" card).
 *
 * Fetched ONCE per page load and shared by every component that calls useMe().
 */
export interface Me {
  loaded: boolean;
  required: boolean;
  role: string | null;
  organisationId: string | null;
  platformAdmin: boolean;
  platformModel: boolean;
}

/** Role ladder, mirrored from src/server/authz.ts (as app.js's ROLE_RANK is). */
const ROLE_RANK: Record<string, number> = { viewer: 1, tester: 2, admin: 3, owner: 4 };
export const roleAtLeast = (actual: string | null | undefined, required: string): boolean =>
  (ROLE_RANK[actual ?? ""] || 0) >= (ROLE_RANK[required] || 0);

// Until /config answers we behave like the classic UI before refreshIdentity(): required with no
// role, so nothing role-gated is drawn and then disappears.
const INITIAL: Me = { loaded: false, required: true, role: null, organisationId: null, platformAdmin: false, platformModel: false };

let pending: Promise<Me> | null = null;
let cached: Me | null = null;

function loadMe(): Promise<Me> {
  pending ??= (async () => {
    const [cfg, health] = await Promise.all([
      api<{ authEnabled?: boolean }>("/api/auth/config").catch(() => null),
      api<{ platformAdmins?: boolean }>("/api/health").catch(() => null),
    ]);
    const required = !!cfg?.authEnabled;
    type MeBody = { role?: string | null; organisationId?: string | null; platformAdmin?: boolean };
    const me: MeBody | null = required && session().token
      ? await api<MeBody>("/api/auth/me").catch(() => null)
      : null;
    cached = {
      loaded: true,
      required,
      role: me?.role || null,
      organisationId: me?.organisationId || null,
      platformAdmin: me?.platformAdmin === true,
      platformModel: health?.platformAdmins === true,
    };
    return cached;
  })();
  return pending;
}

export function useMe(): Me {
  const [me, setMe] = useState<Me>(cached ?? INITIAL);
  useEffect(() => {
    let alive = true;
    loadMe().then((m) => { if (alive) setMe(m); });
    return () => { alive = false; };
  }, []);
  return me;
}

/** app.js's gates. `unavailable` = no database (projects fell back to run grouping): nothing to edit. */
export const canAuthor = (me: Me): boolean => !me.required || roleAtLeast(me.role, "tester");
export const canDelete = (me: Me): boolean => !me.required || roleAtLeast(me.role, "admin");
export const canManageProjects = (me: Me, unavailable: boolean): boolean => canDelete(me) && !unavailable;
export const canAuthorSuites = (me: Me, unavailable: boolean): boolean => canAuthor(me) && !unavailable;
export const canDeleteSuites = (me: Me, unavailable: boolean): boolean => canDelete(me) && !unavailable;
