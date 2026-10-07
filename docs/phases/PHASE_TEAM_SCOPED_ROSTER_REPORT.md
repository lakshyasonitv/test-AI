# Phase — Team roster scoped to shared projects

Below admin, the Team screen used to list every member of the organisation — every email and role
— and the API behind it returned the same to anyone who called it. Now a tester or viewer sees
themselves plus the members who share at least one project with them, with read-only chips for
only those shared projects. Owner and admin are unchanged. Rationale: `DECISIONS.md` D-36.

**Always on, no env flag** — an explicit, recorded exception to platform rule 2 (D-36). No route
was added; no route's request or response *shape* changed (rule 1). No CSS class minted (rule 3).
Nothing committed, deployed, or applied to a database.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/server/projects.ts` | New `assignmentsVisibleTo(orgId, viewerId, role)`: the assignments map cut to the viewer's visible projects (via `visibleProjectIds`), current members only. Admin/owner get `assignmentsByUser` unchanged. |
| `src/server/organisations.ts` | `listMembers` takes an optional id list that filters the **query**. New `listMembersVisibleTo`: admin/owner → everyone; below → self + `assignmentsVisibleTo`'s people. |
| `src/server/index.ts` | `GET …/members` returns `listMembersVisibleTo`. `GET …/assignments` goes from `requireOrgRole("admin")` to `requireOrgRole("viewer")`, returning the scoped map. |
| `public/app.js` | Team button shown to any signed-in member with a role. Assignments fetched for every role. Chip `×` and "+ Add to project…" drawn only for admins; chips are read-only below. |
| `supabase/migrations/20261007120000_roster_scoped_to_shared_projects.sql` | **New, NOT applied.** `private.user_visible_member_keys()` + a replacement `organisation_members` read policy, matched per organisation. Commented rollback at the bottom. |
| `tests/teamRoster.test.ts` | **New**, 24 tests (mocked Supabase, real middleware and routes). |
| `tests/tenancy.test.ts` | Two tests updated to the new contract (viewer's roster is scoped; assignments open but scoped). |
| `tests/rlsPolicies.integration.test.ts` | New roster block, 5 tests. **Skipped without a database; not run.** |
| docs | `DECISIONS.md` D-36, `TECH_DEBT.md` TD-109/TD-110, `PHASE_TEAM_REPORT.md` route table, this report. |

## 2. WHAT WAS ALREADY TRUE (verified, not changed)

- `POST /api/projects/:id/members` and `DELETE /api/projects/:id/members/:userId` were already
  `requireRole("admin")` → 403 for tester/viewer, and the UI already drew neither control below
  admin. Change 2 needed tests only.
- The role dropdown and the Remove button were already admin-only in both the server
  (`requireOrgRole("admin")` plus the never-above-yourself and last-owner guards) and the UI.
- No browser code reads `organisation_members` or `project_members` from Supabase: `public/` only
  calls `/auth/v1/*`. The only non-service-role clients on the server (`auth.ts`, `signup.ts`)
  read no tables. So the new RLS policy changes nothing the app reads.

## 3. VERIFICATION

- `npx tsc --noEmit` clean; full `npx vitest run` green (see the commit for the count).
- Negative controls: six separate mutations — roster unscoped, chips not cut, stale-member guard
  removed, assignments back to admin-only, project-add opened to tester, chip `×` drawn for
  everyone — each turns at least one test in `teamRoster.test.ts` red.
- **Not verified:** the RLS policy against a real Postgres (`npm run test:rls`), and the screen in a
  real browser with real accounts. Both need a database; see section 5.

## 4. ROLLOUT ORDER

Either order is safe — the app reads with the service-role key, so the policy and the code are
independent — but deploy the code first: it is what users see, and the migration only closes the
direct-PostgREST path.

1. Deploy the code.
2. Run `npm run test:rls` against a Supabase **branch** with the migration applied.
3. Apply `20261007120000_roster_scoped_to_shared_projects.sql` to production.

## 5. DELIBERATELY NOT DONE

- **Testers don't see admins/owners** unless one is assigned to a shared project — the rule as
  specified. D-36 records it so it isn't "fixed" by accident.
- **TD-109** (`removeMember` leaves `project_members` rows) is guarded against, not fixed — fixing
  it is a data change that needs sign-off.
- **TD-110** (a pre-existing test-ordering failure) filed, not investigated.
- The Team page heading still reads "Who can use this workspace" for every role.
