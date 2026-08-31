import { credentialsFromEnv, credentialKindsNeeded, type Credentials } from "../stages/credentials.js";
import { askCredentials } from "./pendingCredentials.js";

/**
 * ENV FIRST, PROMPT SECOND — the one place that policy lives.
 *
 * Three callers need the same answer to the same question: "this is about to sign in; where does
 * the password come from?" A fresh run asks it in the orchestrator, the case editor's re-ground
 * walk asks it before walking, and a replay asks it before executing saved cases. They must all
 * reach it through the SAME `askCredentials` waiter table, so there is one timeout and one set of
 * guarantees, and they must agree that an operator who already set `TEST_USERNAME` /
 * `TEST_PASSWORD` is never prompted.
 *
 * They differ only in which event channel tells the browser to draw the form, which is what
 * `emit` abstracts. Extracted into its own module so it can be tested without standing up the
 * whole server.
 *
 * THE EMIT IS NOT OPTIONAL. `askCredentials` only parks a promise server-side. Without the event
 * the UI never renders the form, and the caller sits for the full CREDENTIAL_WAIT_MS against a
 * screen that offered nowhere to type — a trap this project has hit on more than one path.
 *
 * Nothing here writes. The value lives in the returned promise and in the caller's process memory
 * for the length of one run; it never reaches disk, an event payload, or the database
 * (`CLAUDE.md` rule 5). The events carry only the URL and WHICH fields are wanted, never a value.
 */
export async function resolveCredentialsVia(
  waiterId: string,
  url: string,
  fields: ReturnType<typeof credentialKindsNeeded>,
  emit: (status: "started" | "completed", data: Record<string, unknown>) => void,
): Promise<Credentials | undefined> {
  const fromEnv = credentialsFromEnv();
  if (fromEnv) return fromEnv;

  emit("started", { url, fields });
  const answered = await askCredentials({ runId: waiterId, url, fields });
  emit("completed", { supplied: !!answered });
  return answered ?? undefined;
}
