import { credentialsFromEnv, credentialKindsNeeded, type Credentials } from "../stages/credentials.js";
import { askCredentials } from "./pendingCredentials.js";

/**
 * One waiter, one set of guarantees — and an EXPLICIT resolution order per caller.
 *
 * Three callers need the same answer to the same question: "this is about to sign in; where does
 * the password come from?" A fresh run asks it in the orchestrator, the case editor's re-ground
 * walk asks it before walking, and a replay asks it before executing saved cases. All of them must
 * reach it through the SAME `askCredentials` waiter table, so there is one timeout and one way to
 * park — that part is not negotiable and is why this is one function rather than three.
 *
 * What they do NOT agree on is which source wins, and pretending they did was the flaw in the
 * first version of this file. A background verification inside a save should not interrupt an
 * operator who has already configured the environment; a replay that a person deliberately started
 * should let that person's own credential beat a server-wide variable that may not be their
 * account. So the order is a parameter, named at each call site, rather than a hidden default that
 * silently suits one caller.
 *
 * THE EMIT IS NOT OPTIONAL. `askCredentials` only parks a promise server-side. Without the event
 * the UI never renders the form, and the caller sits for the full CREDENTIAL_WAIT_MS against a
 * screen that offered nowhere to type — a trap this project has hit on more than one path.
 *
 * NOTHING HERE WRITES, on either order. The value lives in the returned promise and in the
 * caller's process memory for the length of one run. It never reaches the IR, the generated spec,
 * `runs/`, the database, or a log line: the events carry only the URL and WHICH fields are wanted,
 * and the value leaves this module only as the return, into `credentialEnvVars` and from there
 * into the Playwright child process's environment (`CLAUDE.md` rule 5, `DECISIONS.md` D-09).
 */
/**
 * Which source wins when both could answer.
 *
 * `"env-first"` — an operator who has already configured `TEST_USERNAME` / `TEST_PASSWORD` is
 * never interrupted. Right for the case editor's re-ground walk: it is a background verification
 * step inside a save the person already asked for, and a prompt there is an interruption they did
 * not initiate.
 *
 * `"prompt-first"` — the person is asked, and the environment is only a fallback for when they
 * supply nothing. Right for a replay: replays are run by a person on a shared server, and a
 * server-wide environment variable is not necessarily THEIR account. A credential someone types
 * must beat one the server happens to be holding.
 *
 * The cost of `"prompt-first"`, stated because it is not free: a replay of a login case now always
 * prompts, and an unanswered prompt parks for the full `CREDENTIAL_WAIT_MS` while holding one of
 * the `MAX_CONCURRENT_RUNS` slots. With `"env-first"` and the variables set, it never prompted and
 * never waited.
 */
export type CredentialOrder = "env-first" | "prompt-first";

export async function resolveCredentialsVia(
  waiterId: string,
  url: string,
  fields: ReturnType<typeof credentialKindsNeeded>,
  emit: (status: "started" | "completed", data: Record<string, unknown>) => void,
  order: CredentialOrder = "env-first",
): Promise<Credentials | undefined> {
  if (order === "env-first") {
    const fromEnv = credentialsFromEnv();
    if (fromEnv) return fromEnv;
  }

  emit("started", { url, fields });
  const answered = await askCredentials({ runId: waiterId, url, fields });
  // Reports whether the PERSON answered — not whether the run ended up with credentials. Those
  // differ under "prompt-first" when the prompt is skipped and the environment covers it, and the
  // honest thing for the event to say is what the person did.
  emit("completed", { supplied: !!answered });
  if (answered) return answered;

  // Skipped, or timed out. Under "prompt-first" the environment is the fallback; under
  // "env-first" it was already consulted above and returned nothing, so this is a no-op.
  return order === "prompt-first" ? credentialsFromEnv() : undefined;
}
