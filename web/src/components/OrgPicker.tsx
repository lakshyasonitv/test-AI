import { useEffect, useState } from "react";
import { loadHealth, loadIdentity } from "../lib/identity";
import { acctFetch, setAdminOrgId } from "../lib/session";

export interface Org { id: string; name: string; members: number; projects: number }

/** app.js switchAdminOrg: remember the organisation for this tab, then load everything again. */
export function switchAdminOrg(orgId: string | null): void {
  setAdminOrgId(orgId || null);
  location.hash = "#/dashboard";
  location.reload();
}

/**
 * The topbar organisation picker (app.js #orgPicker), platform admins only; renders nothing for
 * anyone else, while the platform-admin model is off, or when there are no organisations.
 */
export function OrgPicker() {
  const [state, setState] = useState<{ orgs: Org[]; current: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [health, me] = await Promise.all([loadHealth(), loadIdentity().catch(() => null)]);
      if (!health.platformAdmins || !me?.platformAdmin) return;
      const res = await acctFetch("/api/admin/organisations").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const orgs: Org[] = res && Array.isArray(res.organisations) ? res.organisations : [];
      if (alive && orgs.length) setState({ orgs, current: me.organisationId });
    })();
    return () => { alive = false; };
  }, []);
  if (!state) return null;
  return (
    <select id="orgPicker" className="team-select" aria-label="Organisation you are working in" title="Organisation you are working in"
      defaultValue={state.current ?? undefined} onChange={(e) => switchAdminOrg(e.target.value)}>
      {state.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}
