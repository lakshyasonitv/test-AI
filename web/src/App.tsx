import { useEffect, useState } from "react";
import { api, classic, session } from "./api";
import { useRoute, type Route } from "./router";
import { CasePage } from "./pages/Case";
import { HistoryPage } from "./pages/History";
import { ProjectPage } from "./pages/Project";
import { ProjectsPage } from "./pages/Projects";
import { SuitePage } from "./pages/Suite";
import { Empty, Loading } from "./ui";

/**
 * The React UI (served at /app/). Same session, same routes and same API as the classic UI at /;
 * pages not rebuilt in React yet link to their classic page.
 */
export function App() {
  const route = useRoute();
  const [auth, setAuth] = useState<"checking" | "ok" | "signin">("checking");

  useEffect(() => {
    api<{ authEnabled: boolean }>("/api/auth/config")
      .then((c) => setAuth(c.authEnabled && !session().token ? "signin" : "ok"))
      .catch(() => setAuth("ok"));
  }, []);

  return (
    <div className="rx-app">
      <header className="rx-top">
        <a className="rx-brand" href="#/projects"><span className="rx-dots" aria-hidden="true" />Testbench <span className="rx-tag">React</span></a>
        <nav className="rx-nav" aria-label="Main">
          <a href={classic("#/dashboard")}>Dashboard</a>
          <a href={classic("#/")}>New test</a>
          <a href="#/projects" className={route.name === "projects" || route.name === "project" || route.name === "suite" || route.name === "case" ? "on" : ""}>Projects</a>
          <a href="#/history" className={route.name === "history" ? "on" : ""}>History</a>
        </nav>
        <a className="rx-classic" href={classic(location.hash || "#/")}>Open in classic UI</a>
      </header>
      <main className="rx-main">
        {auth === "checking" && <Loading />}
        {auth === "signin" && (
          <Empty>
            You are not signed in. <a href={classic("#/")}>Sign in on the classic UI</a>, then come back here; both use the same session.
          </Empty>
        )}
        {auth === "ok" && <Page route={route} />}
      </main>
    </div>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "projects": return <ProjectsPage />;
    case "project": return <ProjectPage projectId={route.projectId} />;
    case "suite": return <SuitePage key={route.suiteId} suiteId={route.suiteId} />;
    case "case": return <CasePage key={route.caseId} caseId={route.caseId} />;
    case "history": return <HistoryPage />;
    default:
      return (
        <div className="wide">
          <Empty>
            This page is not in the React UI yet. <a href={classic(route.hash)}>Open it in the classic UI</a>.
          </Empty>
        </div>
      );
  }
}
