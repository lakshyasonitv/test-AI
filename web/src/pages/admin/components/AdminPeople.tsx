import { useEffect, useState } from "react";
import { acctFetch, jsonBody } from "../../../lib/session";
import { Loading } from "../../../components/ui";
import { ADMIN_ROLES, type Member } from "../types";

/** One organisation's people: who is in it, New user, and Move an existing account here. */
export function AdminPeople({ orgId, toast, onChanged }: { orgId: string; toast: (m: string) => void; onChanged: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [msg, setMsg] = useState("");
  const [uEmail, setUEmail] = useState("");
  const [uPass, setUPass] = useState("");
  const [uRole, setURole] = useState("owner");
  const [mEmail, setMEmail] = useState("");
  const [mRole, setMRole] = useState("tester");
  const q = encodeURIComponent(orgId);

  useEffect(() => {
    let alive = true;
    acctFetch(`/api/organisations/${q}/members`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((res) => { if (alive) setMembers(res && Array.isArray(res.members) ? res.members : []); });
    return () => { alive = false; };
  }, [q]);

  const call = async (url: string, payload: unknown, ok: (o: { email?: string; role?: string }) => string) => {
    const r = await acctFetch(url, jsonBody("POST", payload));
    const out = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(out.error || "That didn't work."); return; }
    toast(ok(out));
    onChanged();
  };

  const remove = async (m: Member) => {
    const who = m.email || "this person";
    if (!confirm(`Remove ${who} from this organisation? They will no longer see anything in it.`)) return;
    const r = await acctFetch(`/api/organisations/${q}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
    if (!r.ok) { const out = await r.json().catch(() => ({})); setMsg(out.error || "That didn't work."); return; }
    toast(`${who} removed.`);
    onChanged();
  };

  const createUser = () => {
    const email = uEmail.trim();
    if (!email) { setMsg("Enter the new user's email."); return; }
    if (uPass.length < 8) { setMsg("The password needs at least 8 characters."); return; }
    void call(`/api/organisations/${q}/users`, { email, password: uPass, role: uRole },
      (o) => `${o.email} created as ${o.role}. Give them their email and password to sign in.`);
  };

  const moveUser = () => {
    const email = mEmail.trim();
    if (!email) { setMsg("Enter the account's email."); return; }
    if (!confirm(`Move ${email} into this organisation as ${mRole}? They leave any other organisation.`)) return;
    void call(`/api/admin/organisations/${q}/move-user`, { email, role: mRole }, (o) => `${o.email} moved here as ${o.role}.`);
  };

  return (
    <div data-adm-people={orgId} style={{ margin: "0 0 10px 14px" }}>
      {members === null ? (
        <div className="tree-empty" style={{ padding: "12px 4px" }}><Loading /></div>
      ) : (
        <>
          {members.length ? members.map((m) => (
            <div className="hrow" key={m.userId}>
              <div className="hrow-main"><div className="hrow-label">{m.email || "(unknown address)"}</div></div>
              <span className="case-badge badge-pending">{m.role === "admin" ? "owner" : m.role}</span>
              <div className="hrow-actions">
                <button type="button" className="dl-btn-inline hrow-del" onClick={() => void remove(m)}>Remove</button>
              </div>
            </div>
          )) : <div className="hrow-meta" style={{ padding: "6px 0" }}>Nobody here yet.</div>}
          <div className="hrow-meta" style={{ margin: "12px 0 4px" }}>New user in this organisation</div>
          <div data-dash="form">
            <input type="email" className="project-form-input" data-adm="u-email" placeholder="name@company.com" aria-label="New user's email"
              autoComplete="off" value={uEmail} onChange={(e) => setUEmail(e.target.value)} />
            <input type="password" className="project-form-input" data-adm="u-pass" placeholder="Password (8+ characters)" aria-label="New user's password"
              autoComplete="new-password" value={uPass} onChange={(e) => setUPass(e.target.value)} />
            <select className="team-select" data-adm="u-role" aria-label="New user's role" value={uRole} onChange={(e) => setURole(e.target.value)}>
              {ADMIN_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="button" className="dl-btn" data-adm-act="u-create" onClick={createUser}>Create user</button>
          </div>
          <div className="hrow-meta" style={{ margin: "12px 0 4px" }}>Move an existing account here (takes it out of any other organisation)</div>
          <div data-dash="form">
            <input type="email" className="project-form-input" data-adm="m-email" placeholder="their@email.com" aria-label="Account to move"
              autoComplete="off" value={mEmail} onChange={(e) => setMEmail(e.target.value)} />
            <select className="team-select" data-adm="m-role" aria-label="Role after the move" value={mRole} onChange={(e) => setMRole(e.target.value)}>
              {ADMIN_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="button" className="dl-btn" data-adm-act="u-move" onClick={moveUser}>Move here</button>
          </div>
          <div className="hrow-meta" data-adm="p-msg" aria-live="polite" style={{ marginTop: 6 }}>{msg}</div>
        </>
      )}
    </div>
  );
}
