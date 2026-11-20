
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * D-84 "Who can see this project" (app.js renderProjectMembers): testers and viewers in the
 * project, Remove for each, and an "+ Add person…" picker of the organisation's testers/viewers
 * not yet in it. Owners see every project, so they are left out of both lists.
 */
export interface Member { userId: string; email?: string | null; role?: string }
