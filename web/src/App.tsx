import { useEffect, useState } from "react";
import { classic } from "./api";
import { useRoute, type Route } from "./router";
import { AdminPage, OrgPicker } from "./pages/Admin";
import { CasePage } from "./pages/Case";
import { CompareView } from "./pages/Compare";
import { DashboardPage } from "./pages/Dashboard";
import { HistoryPage } from "./pages/History";
import { LoginPage, signOut } from "./pages/Login";
import { NewTestPage } from "./pages/NewTest";
import { ProjectPage } from "./pages/Project";
import { ProjectsPage } from "./pages/Projects";
import { RunPage } from "./pages/Run";
import { SettingsPage, SettingsPopover } from "./pages/Settings";
import { SuitePage } from "./pages/Suite";
import { TeamPage } from "./pages/Team";
import { currentToken, ensureAuth, SIGNED_OUT_EVENT } from "./pages/account/session";
import { loadIdentity, type Identity } from "./pages/account/identity";
import { Empty, Loading } from "./ui";

/**
 * The React UI (served at /app/). Same session, same routes and same API as the classic UI at /.
 *
 * Auth follows the classic initAuth: GET /api/auth/config (via ensureAuth, which also starts token
 * refresh when the server enables it); with auth on and no session, the sign-in screen; signing
 * out anywhere (SIGNED_OUT_EVENT) returns to it.
 */
export function App() {
  const route = useRoute();
  const [auth, setAuth] = useState<"checking" | "ok" | "signin">("checking");
  const [screen, setScreen] = useState<"login" | "signup">("login");
  const [me, setMe] = useState<Identity | null>(null);

  const decide = () => {
    ensureAuth()
      .then((cfg) => setAuth(cfg.authEnabled && !currentToken() ? "signin" : "ok"))
      .catch(() => setAuth("ok"));
  };
  useEffect(decide, []);
  useEffect(() => {
    const out = () => { setMe(null); setScreen("login"); setAuth("signin"); };
    window.addEventListener(SIGNED_OUT_EVENT, out);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, out);
  }, []);
  useEffect(() => {
    if (auth !== "ok") return;
    loadIdentity().then(setMe).catch(() => setMe(null));
  }, [auth]);

  if (auth === "signin") {
    return <LoginPage mode={screen} onSignedIn={() => { setAuth("ok"); loadIdentity(true).then(setMe).catch(() => {}); }} />;
  }

  // Classic: Team shows when auth is on, you are signed in and your role is known.
  const showTeam = !!me?.authRequired && !!currentToken() && !!me?.role;
  const inLibrary = ["projects", "project", "suite", "case", "compare"].includes(route.name);

  return (
    <div className="rx-app">
      <header className="rx-top">
        <a className="rx-brand" href="#/dashboard"><span className="rx-dots" aria-hidden="true" />Testbench <span className="rx-tag">React</span></a>
        <nav className="rx-nav" aria-label="Main">
          <a href="#/dashboard" className={route.name === "dashboard" ? "on" : ""}>Dashboard</a>
          <a href="#/" className={route.name === "newtest" ? "on" : ""}>New test</a>
          <a href="#/projects" className={inLibrary ? "on" : ""}>Projects</a>
          <a href="#/history" className={route.name === "history" || route.name === "run" ? "on" : ""}>History</a>
          {showTeam && <a href="#/team" className={route.name === "team" ? "on" : ""}>Team</a>}
          {me?.platformAdmin && <a href="#/admin" className={route.name === "admin" ? "on" : ""}>Admin</a>}
        </nav>
        <div className="rx-right">
          {me?.platformAdmin && <OrgPicker />}
          <SettingsPopover />
          {me?.authRequired && currentToken() && (
            <>
              <span className="rx-who" title={me.organisationName ?? ""}>{me.email}{me.role ? ` · ${me.role}` : ""}</span>
              <button type="button" className="dl-btn-inline" onClick={() => { void signOut(); }}>Sign out</button>
            </>
          )}
          <a className="rx-classic" href={classic(location.hash || "#/")}>Classic UI</a>
        </div>
      </header>
      <main className="rx-main">
        {auth === "checking" ? <Loading /> : <Page route={route} />}
      </main>
    </div>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "newtest": return <NewTestPage />;
    case "dashboard": return <DashboardPage />;
    case "run": return <RunPage key={route.runId} runId={route.runId} />;
    case "projects": return <ProjectsPage />;
    case "project": return <ProjectPage key={route.projectId} projectId={route.projectId} />;
    case "suite": return <SuitePage key={route.suiteId} suiteId={route.suiteId} />;
    case "case": return <CasePage key={route.caseId} caseId={route.caseId} />;
    case "compare": return <CompareView key={`${route.caseId}:${route.from}:${route.to}`} caseId={route.caseId} from={route.from} to={route.to} />;
    case "history": return <HistoryPage />;
    case "settings": return <SettingsPage />;
    case "team": return <TeamPage />;
    case "admin": return <AdminPage />;
    case "notBuilt":
      return (
        <div className="wide">
          <Empty>This page is not in the React UI. <a href={classic(route.hash)}>Open it in the classic UI</a>.</Empty>
        </div>
      );
  }
}
