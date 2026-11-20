import { useCallback, useEffect, useState } from "react";
import { loadHealth, loadIdentity, roleAtLeast, shortProjectName, type Identity } from "../../lib/identity";
import { acctFetch, jsonBody } from "../../lib/session";
import { Loading } from "../../components/ui";
import { RoleOptions } from "./components/RoleOptions";
import { LlmConfigPanel } from "./components/LlmConfigPanel";
import { Feedback } from "./types";

/**
 * Team (#/team) — app.js renderTeamView + teamCall + renderLlmConfigPanel. Members of your
 * organisation; for admins and owners the controls to add (or, with the platform-admin model,
 * create) people, change roles, remove them, and assign projects; and the organisation's Gemini
 * configuration. Hiding a control is a courtesy: the server enforces every call regardless and its
 * own refusal message is shown verbatim.
 */

const ROLE_HELP: Record<string, string> = {
  viewer: "Read-only — can see runs and results, cannot start or delete them.",
  tester: "Runs tests — talks to the AI, answers login prompts, picks cases. Cannot delete.",
  admin: "Manages people and can delete runs.",
  owner: "Full control of the organisation.",
};

interface Member { userId: string; email?: string | null; role: string }
interface ProjectLite { id: string; name: string }

export function TeamPage() {
  const [me, setMe] = useState<Identity | null>(null);
  const [platformModel, setPlatformModel] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadingRows, setLoadingRows] = useState(true);
  const [data, setData] = useState<{
    members: Member[]; error?: string; assignments: Record<string, string[]>; projects: ProjectLite[];
  }>({ members: [], assignments: {}, projects: [] });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [gen, setGen] = useState(0);

  // Add / create forms (reset whenever the view is redrawn after a change, as app.js's innerHTML is).
  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState("tester");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("tester");
  const [newProject, setNewProject] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const orgId = me?.organisationId ?? null;

  const loadRows = useCallback(async (org: string) => {
    setLoadingRows(true);
    const res = await acctFetch(`/api/organisations/${encodeURIComponent(org)}/members`)
      .then((r) => r.json()).catch(() => null);
    const members: Member[] = res && Array.isArray(res.members) ? res.members : [];
    const [aRes, pRes] = await Promise.all([
      acctFetch(`/api/organisations/${encodeURIComponent(org)}/assignments`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      acctFetch("/api/projects").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    setData({
      members,
      error: res?.error,
      assignments: (aRes && aRes.assignments) || {},
      projects: pRes && Array.isArray(pRes.projects) ? pRes.projects : [],
    });
    setLoadingRows(false);
  }, []);

  /** Redraw: identity (our own role may have changed), the rows, the forms and the LLM panel. */
  const redraw = useCallback(async (forceIdentity: boolean) => {
    const [id, health] = await Promise.all([loadIdentity(forceIdentity).catch(() => null), loadHealth()]);
    setMe(id);
    setPlatformModel(health.platformAdmins);
    setReady(true);
    setAddEmail(""); setAddRole("tester");
    setNewEmail(""); setNewPassword(""); setNewRole("tester"); setNewProject(""); setShowPassword(false);
    setGen((g) => g + 1);
    if (id?.organisationId) await loadRows(id.organisationId);
  }, [loadRows]);

  useEffect(() => { void redraw(false); }, [redraw]);

  /** app.js teamCall: the server's own message on failure; redraw then the message on success. */
  const teamCall = async (url: string, init: RequestInit, successMessage: string) => {
    try {
      const res = await acctFetch(url, init);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `That didn't work (${res.status}).`);
      }
      await redraw(true);
      setFeedback({ message: successMessage, isError: false });
    } catch (err) {
      setFeedback({ message: (err instanceof Error && err.message) || "That didn't work.", isError: true });
    }
  };

  const feedbackEl = feedback && (
    <p className={feedback.isError ? "team-error" : "team-ok"} role={feedback.isError ? "alert" : "status"}>{feedback.message}</p>
  );

  const head = (
    <div>
      <div className="eyebrow">TEAM</div>
      <h1 className="page-head-title">Who can use this workspace</h1>
      <p className="tagline">Roles decide what each person may do. Every role is enforced on the
        server — hiding a button here is only a convenience.</p>
    </div>
  );

  if (!ready) {
    return <section className="view view-active" data-view="team" id="view-team"><div className="wide" id="teamViewBody">{head}<Loading /></div></section>;
  }

  if (!orgId) {
    return (
      <section className="view view-active" data-view="team" id="view-team">
        <div className="wide" id="teamViewBody">
          {head}
          <div id="teamFeedback">{feedbackEl}</div>
          <div className="panel"><div id="teamRows">
            <div className="tree-empty" style={{ padding: "36px 16px", textAlign: "center" }}>Sign in to see your organisation's members.</div>
          </div></div>
        </div>
      </section>
    );
  }

  const role = me?.role ?? null;
  const isAdmin = roleAtLeast(role, "admin");
  const { members, assignments, projects } = data;
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const ownerCount = members.filter((m) => m.role === "owner").length;

  const createUser = () => {
    const email = newEmail.trim();
    if (!email) return setFeedback({ message: "Enter the new user's email.", isError: true });
    if (newPassword.length < 8) return setFeedback({ message: "The password needs at least 8 characters.", isError: true });
    const projectId = newProject || undefined;
    void teamCall(`/api/organisations/${encodeURIComponent(orgId)}/users`,
      jsonBody("POST", { email, password: newPassword, role: newRole, ...(projectId ? { projectId } : {}) }),
      `${email} created as ${newRole}${me?.organisationName ? ` in ${me.organisationName}` : ""}. Give them their email and password to sign in.`);
  };

  const addMember = () => {
    const email = addEmail.trim();
    if (!email) return setFeedback({ message: "Enter the email address of an existing account.", isError: true });
    void teamCall(`/api/organisations/${encodeURIComponent(orgId)}/members`,
      jsonBody("POST", { email, role: addRole }), `${email} added as ${addRole}.`);
  };

  return (
    <section className="view view-active" data-view="team" id="view-team">
      <div className="wide" id="teamViewBody">
        {head}
        <div id="teamFeedback">{feedbackEl}</div>
        <div id="teamAddWrap">
          {isAdmin && platformModel && (
            <div className="team-add">
              <label className="field">
                <span className="field-label">New user's email</span>
                <input id="teamNewEmail" type="email" placeholder="name@company.com" autoComplete="off" spellCheck={false}
                  value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Password</span>
                <input id="teamNewPassword" type={showPassword ? "text" : "password"} placeholder="8 or more characters"
                  autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              </label>
              <label className="field" style={{ flex: "0 0 130px" }}>
                <span className="field-label">Role</span>
                <select id="teamNewRole" className="team-select" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                  <RoleOptions maxRole={role} platformModel={platformModel} />
                </select>
              </label>
              <label className="field" style={{ flex: "0 0 190px" }}>
                <span className="field-label">First project (optional)</span>
                <select id="teamNewProject" className="team-select" value={newProject} onChange={(e) => setNewProject(e.target.value)}>
                  <option value="">None</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{shortProjectName(p.name)}</option>)}
                </select>
              </label>
              <div className="team-add-actions">
                <label className="hrow-meta" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" id="teamNewShow" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} /> Show password</label>
                <button type="button" id="teamNewBtn" className="dl-btn-inline" onClick={createUser}>Create user</button>
              </div>
            </div>
          )}
          {isAdmin && !platformModel && (
            <div className="team-add">
              <label className="field">
                <span className="field-label">Email of an existing account</span>
                {/* Plain free text, no suggestions: a datalist here once listed every address on the instance. */}
                <input id="teamAddEmail" type="email" placeholder="someone@example.com" autoComplete="off" spellCheck={false}
                  value={addEmail} onChange={(e) => setAddEmail(e.target.value)} />
              </label>
              <label className="field" style={{ flex: "0 0 150px" }}>
                <span className="field-label">Role</span>
                <select id="teamAddRole" className="team-select" value={addRole} onChange={(e) => setAddRole(e.target.value)}>
                  <RoleOptions maxRole={role} platformModel={platformModel} />
                </select>
              </label>
              <div className="team-add-actions">
                <button type="button" id="teamAddBtn" className="dl-btn-inline" onClick={addMember}>Add to team</button>
              </div>
            </div>
          )}
        </div>
        <div className="panel"><div id="teamRows">
          {loadingRows ? <Loading /> : !members.length ? (
            <div className="tree-empty" style={{ padding: "36px 16px", textAlign: "center" }}>{data.error || "No members found."}</div>
          ) : members.map((m) => {
            const isYou = m.userId === me?.userId;
            const outranksYou = !roleAtLeast(role, m.role);
            const lastOwner = m.role === "owner" && ownerCount <= 1;
            const canEdit = isAdmin && !outranksYou && !lastOwner;
            const seesEverything = roleAtLeast(m.role, "admin");
            const mine = assignments[m.userId] || [];
            return (
              <div className="team-row" key={m.userId}>
                <div className="team-row-main">
                  <span className="team-email">{m.email || "(unknown address)"}{isYou && <span className="team-you">YOU</span>}</span>
                  <span className="team-meta">{ROLE_HELP[m.role] || ""}</span>
                  {seesEverything ? (
                    <div className="team-projects"><span className="team-projects-all">Sees every project (by role)</span></div>
                  ) : (
                    <div className="team-projects">
                      {mine.length ? mine.map((pid) => (
                        <span className="team-chip" key={pid}>{projectName.get(pid) || "project"}
                          {isAdmin && (
                            <button type="button" className="team-chip-x" title="Remove from this project"
                              onClick={() => void teamCall(
                                `/api/projects/${encodeURIComponent(pid)}/members/${encodeURIComponent(m.userId)}`,
                                { method: "DELETE" }, "Removed from the project.")}>&times;</button>
                          )}
                        </span>
                      )) : (
                        <span className="team-projects-none">
                          {isYou ? "You haven't been added to any projects yet." : "No projects yet — they can't see anything."}
                        </span>
                      )}
                      {isAdmin && projects.length > mine.length && (
                        <select className="team-select team-assign" value=""
                          onChange={(e) => {
                            if (!e.target.value) return;
                            void teamCall(`/api/projects/${encodeURIComponent(e.target.value)}/members`,
                              jsonBody("POST", { userId: m.userId }), "Added to the project.");
                          }}>
                          <option value="">+ Add to project…</option>
                          {projects.filter((p) => !mine.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      )}
                    </div>
                  )}
                </div>
                <div className="team-row-actions">
                  {canEdit ? (
                    <select className="team-select" value={m.role}
                      onChange={(e) => void teamCall(
                        `/api/organisations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(m.userId)}`,
                        jsonBody("PATCH", { role: e.target.value }), `Role changed to ${e.target.value}.`)}>
                      <RoleOptions maxRole={role} platformModel={platformModel} />
                    </select>
                  ) : (
                    <span className="team-role-static"
                      title={lastOwner ? "The last owner cannot be changed" : outranksYou ? "This member outranks you" : ROLE_HELP[m.role] || ""}>
                      {m.role}
                    </span>
                  )}
                  {canEdit && (
                    <button type="button" className="dl-btn-inline hrow-del"
                      onClick={() => {
                        if (!confirm("Remove this person from the organisation?")) return;
                        void teamCall(`/api/organisations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(m.userId)}`,
                          { method: "DELETE" }, "Member removed.");
                      }}>Remove</button>
                  )}
                </div>
              </div>
            );
          })}
        </div></div>
        <div id="llmConfigWrap">{isAdmin && <LlmConfigPanel key={gen} orgId={orgId} />}</div>
      </div>
    </section>
  );
}
