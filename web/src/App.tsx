import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { Header } from "./components/Header";
import { Empty, Loading } from "./components/ui";
import { classic } from "./lib/api";
import { loadIdentity, type Identity } from "./lib/identity";
import { useRoute, type Route } from "./lib/router";
import { currentToken, ensureAuth, SIGNED_OUT_EVENT } from "./lib/session";

/**
 * The React UI (served at /app/). Same session, same routes and same API as the classic UI at /.
 *
 * Every page is lazy: its code is a separate file the browser downloads only when that page is
 * first opened (then it is cached). The first load carries just this shell, the header and lib/.
 *
 * Auth follows the classic initAuth: GET /api/auth/config (via ensureAuth, which also starts token
 * refresh when the server enables it); with auth on and no session, the sign-in screen; signing
 * out anywhere (SIGNED_OUT_EVENT) returns to it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const page = <K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));

const DashboardPage = page(() => import("./pages/dashboard/DashboardPage"), "DashboardPage");
const NewTestPage = page(() => import("./pages/newtest/NewTestPage"), "NewTestPage");
const RunPage = page(() => import("./pages/run/RunPage"), "RunPage");
const ProjectsPage = page(() => import("./pages/projects/ProjectsPage"), "ProjectsPage");
const ProjectPage = page(() => import("./pages/projects/ProjectPage"), "ProjectPage");
const SuitePage = page(() => import("./pages/suite/SuitePage"), "SuitePage");
const CasePage = page(() => import("./pages/case/CasePage"), "CasePage");
const CompareView = page(() => import("./pages/compare/ComparePage"), "CompareView");
const HistoryPage = page(() => import("./pages/history/HistoryPage"), "HistoryPage");
const SettingsPage = page(() => import("./pages/settings/SettingsPage"), "SettingsPage");
const TeamPage = page(() => import("./pages/team/TeamPage"), "TeamPage");
const AdminPage = page(() => import("./pages/admin/AdminPage"), "AdminPage");
const LoginPage = page(() => import("./pages/login/LoginPage"), "LoginPage");
const RecordPage = page(() => import("./pages/record/RecordPage"), "RecordPage");

export function App() {
  const route = useRoute();
  const [auth, setAuth] = useState<"checking" | "ok" | "signin">("checking");
  const [screen, setScreen] = useState<"login" | "signup">("login");
  const [me, setMe] = useState<Identity | null>(null);

  useEffect(() => {
    ensureAuth()
      .then((cfg) => setAuth(cfg.authEnabled && !currentToken() ? "signin" : "ok"))
      .catch(() => setAuth("ok"));
  }, []);
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
    return (
      <Suspense fallback={<Loading />}>
        <LoginPage mode={screen} onSignedIn={() => { setAuth("ok"); loadIdentity(true).then(setMe).catch(() => {}); }} />
      </Suspense>
    );
  }

  return (
    <div className="rx-app">
      <Header route={route} me={me} />
      <main className="rx-main">
        {auth === "checking" ? <Loading /> : (
          <Suspense fallback={<Loading />}>
            <Page route={route} />
          </Suspense>
        )}
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
    case "record": return <RecordPage key={route.projectId} projectId={route.projectId} />;
    case "notBuilt":
      return (
        <div className="wide">
          <Empty>This page is not in the React UI. <a href={classic(route.hash)}>Open it in the classic UI</a>.</Empty>
        </div>
      );
  }
}
