import { classic } from "../lib/api";
import { signOut, type Identity } from "../lib/identity";
import type { Route } from "../lib/router";
import { currentToken } from "../lib/session";
import { OrgPicker } from "./OrgPicker";
import { SettingsPopover } from "./SettingsPopover";

/** The top bar on every page: brand, main menu, org picker, Settings, who is signed in, Classic UI. */
export function Header({ route, me }: { route: Route; me: Identity | null }) {
  // Classic: Team shows when auth is on, you are signed in and your role is known.
  const showTeam = !!me?.authRequired && !!currentToken() && !!me?.role;
  const inLibrary = ["projects", "project", "suite", "case", "compare"].includes(route.name);
  const on = (yes: boolean) => (yes ? "on" : "");

  return (
    <header className="rx-top">
      <a className="rx-brand" href="#/dashboard"><span className="rx-dots" aria-hidden="true" />Testbench <span className="rx-tag">React</span></a>
      <nav className="rx-nav" aria-label="Main">
        <a href="#/dashboard" className={on(route.name === "dashboard")}>Dashboard</a>
        <a href="#/" className={on(route.name === "newtest")}>New test</a>
        <a href="#/projects" className={on(inLibrary)}>Projects</a>
        <a href="#/history" className={on(route.name === "history" || route.name === "run")}>History</a>
        {showTeam && <a href="#/team" className={on(route.name === "team")}>Team</a>}
        {me?.platformAdmin && <a href="#/admin" className={on(route.name === "admin")}>Admin</a>}
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
  );
}
