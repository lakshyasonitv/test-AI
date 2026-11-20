import { roleAtLeast, ROLES_ASC } from "../../../lib/identity";

/** app.js teamRoleOptions: never offer a role above your own; no "admin" under the platform model. */
export function RoleOptions({ maxRole, platformModel }: { maxRole: string | null; platformModel: boolean }) {
  return (
    <>
      {ROLES_ASC.filter((r) => roleAtLeast(maxRole, r)).filter((r) => !(platformModel && r === "admin"))
        .map((r) => <option key={r} value={r}>{r}</option>)}
    </>
  );
}
