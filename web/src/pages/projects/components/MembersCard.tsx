import { useState, type ReactNode } from "react";
import { api } from "../../../lib/api";
import { Loading, useLoad } from "../../../components/ui";
import { JSON_HEADERS, type LibProject } from "../../../lib/library";
import { type Me } from "../../../lib/useMe";
import { errText, type Member } from "../helpers";

export function MembersCard({ project, me }: { project: LibProject; me: Me }) {
  const [ver, setVer] = useState(0);
  const [err, setErr] = useState("");
  const pid = encodeURIComponent(project.id);
  const { data } = useLoad(`members:${project.id}:${me.organisationId}:${ver}`, async () => {
    if (!me.organisationId) return null;
    const [m, o] = await Promise.all([
      api<{ members?: Member[] }>(`/api/projects/${pid}/members`).catch(() => null),
      api<{ members?: Member[] }>(`/api/organisations/${encodeURIComponent(me.organisationId)}/members`).catch(() => null),
    ]);
    return { inProject: Array.isArray(m?.members) ? m!.members! : [], people: Array.isArray(o?.members) ? o!.members! : [] };
  });
  // Classic draws nothing inside the card without an organisation (its loading text just stays).
  if (!me.organisationId) return null;

  const change = async (fn: () => Promise<unknown>) => {
    setErr("");
    try { await fn(); } catch (e) { setErr(errText(e) || "That didn't work."); }
    setVer((v) => v + 1);
  };

  let content: ReactNode = <div className="tree-empty" style={{ padding: "12px 4px" }}><Loading /></div>;
  if (data) {
    const { inProject, people } = data;
    const inIds = new Set(inProject.map((m) => m.userId));
    const roleOf = new Map(people.map((m) => [m.userId, m.role]));
    const addable = people.filter((m) => !inIds.has(m.userId) && (m.role === "tester" || m.role === "viewer"));
    const listed = inProject.filter((m) => roleOf.get(m.userId) !== "owner");
    content = (
      <>
        {listed.length ? listed.map((m) => (
          <div className="hrow" key={m.userId}>
            <div className="hrow-main"><div className="hrow-label">{m.email || "(unknown address)"}</div>
              <div className="hrow-meta">{roleOf.get(m.userId) || ""}</div></div>
            <div className="hrow-actions">
              <button type="button" className="dl-btn-inline hrow-del"
                onClick={() => change(() => api(`/api/projects/${pid}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" }))}>Remove</button>
            </div>
          </div>
        )) : <div className="hrow-meta" style={{ padding: "6px 0" }}>No testers or viewers yet. Owners see every project.</div>}
        {addable.length > 0 && (
          <select className="team-select" aria-label="Give this project to someone" style={{ marginTop: 8 }} value=""
            onChange={(e) => {
              const userId = e.target.value;
              if (userId) void change(() => api(`/api/projects/${pid}/members`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ userId }) }));
            }}>
            <option value="">+ Add person…</option>
            {addable.map((m) => <option key={m.userId} value={m.userId}>{`${m.email || "(unknown)"} · ${m.role}`}</option>)}
          </select>
        )}
        {err && <p className="team-error">{err}</p>}
      </>
    );
  }
  return (
    <div data-dash="card">
      <div data-dash="card-head"><h2>Who can see this project</h2></div>
      <div>{content}</div>
    </div>
  );
}
