import { createClient } from "@supabase/supabase-js";
import { getServiceClient } from "../db.js";
import { AccessError } from "./authz.js";

/**
 * Server-side sign-up, because Supabase's public one does not work on this project.
 *
 * `POST <project>/auth/v1/signup` with the publishable key returns **HTTP 504 "upstream request
 * timeout" after ~35 seconds** here. The project has email confirmation on, so Supabase tries to
 * send the confirmation mail through its built-in free-tier sender, that hangs, and the account is
 * never created. The sign-up screen didn't just fail to redirect — it produced nothing at all.
 *
 * The fix is to stop asking the browser to talk to Supabase Auth directly and route sign-up
 * through this server, which holds the service-role key and can use the Admin API:
 * `admin.createUser({ email_confirm: true })` creates a confirmed account instantly and sends no
 * mail. We then exchange the credentials for a session so the caller lands signed in.
 *
 * Deliberately NOT fixed by turning "Confirm email" off in the Supabase dashboard: that is a
 * console toggle nothing in this repo can assert on, in an account the person running this app
 * isn't necessarily signed into. A route we own is testable and cannot silently regress.
 *
 * **This mints real accounts with an admin key**, so everything below treats the request as
 * hostile: the flag, the rate limit, the validation, and the deliberately vague duplicate-email
 * error all exist for that reason.
 */

/** Mirrors the client-side check. Server-side is the one that counts — the client's is UX only. */
const MIN_PASSWORD_LENGTH = 8;

/** Same shape check the sign-up form uses. Not RFC-complete, and not trying to be: the address is
 *  verified for real by the fact that only someone holding it can ever sign in with it. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Open sign-up, on by default.
 *
 * This looks like an exception to "every new capability defaults off", and isn't: the entire
 * sign-up path only exists when `AUTH_ENABLED=true`, which itself defaults off. With the shipped
 * defaults there is no login screen, no sign-up screen, and this route refuses. So the *system*
 * default is unchanged — this flag only decides what happens once someone has already opted into
 * auth, where a sign-up screen that cannot create accounts would be pointless.
 *
 * Set `SIGNUP_ENABLED=false` before exposing this server beyond localhost. Anyone who can reach
 * the port can otherwise create themselves an account.
 */
export function isSignupEnabled(): boolean {
  return process.env.SIGNUP_ENABLED !== "false";
}

// --------------------------------------------------------------------------
// Rate limiting
//
// In-process and per-IP, in the spirit of Semaphore (concurrency.ts): no dependency, no shared
// store, obvious to read. It is a speed bump against someone scripting account creation against a
// tunnelled port, not a defence against a distributed attacker — a second server instance would
// have its own counter. Sufficient for a single local process, which is what this runs on.
// --------------------------------------------------------------------------

const RATE_WINDOW_MS = 15 * 60_000;
const RATE_MAX_ATTEMPTS = 5;

/** ip -> timestamps of attempts still inside the window. */
const attemptsByIp = new Map<string, number[]>();

/**
 * Record an attempt and report whether the caller has exhausted their allowance.
 *
 * Counts *attempts*, not successes: an attacker guessing at whether an address is already
 * registered burns the same budget as someone signing up, so the duplicate-email response can't
 * be used as a free oracle.
 */
export function consumeSignupAttempt(ip: string, now = Date.now()): boolean {
  const cutoff = now - RATE_WINDOW_MS;

  // Opportunistic sweep so the map can't grow forever on a long-lived process. Cheap: it only
  // walks entries, and only on a path that is already rate-limited to a trickle.
  for (const [key, times] of attemptsByIp) {
    const live = times.filter((t) => t > cutoff);
    if (live.length === 0) attemptsByIp.delete(key);
    else attemptsByIp.set(key, live);
  }

  const recent = (attemptsByIp.get(ip) ?? []).filter((t) => t > cutoff);
  recent.push(now);
  attemptsByIp.set(ip, recent);
  return recent.length <= RATE_MAX_ATTEMPTS;
}

/** Test seam — the limiter is module state, and cases must not inherit each other's counters. */
export function resetSignupRateLimit(): void {
  attemptsByIp.clear();
}

export interface SignupResult {
  accessToken: string;
  refreshToken: string | null;
  user: { id: string; email: string | null };
}

/**
 * Create a confirmed account and return a session for it.
 *
 * Note what is NOT here: the password is never logged, never stored, and never returned. It is
 * passed to Supabase and dropped — the same rule `pendingCredentials.ts` follows for the
 * credentials a run collects.
 */
export async function createAccount(email: string, password: string): Promise<SignupResult> {
  const address = email.trim().toLowerCase();

  if (!EMAIL_RE.test(address)) {
    throw new AccessError(400, "Enter a valid email address.");
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new AccessError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const service = getServiceClient();
  if (!service) {
    throw new AccessError(
      503,
      "sign-up is not configured on this server — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing",
    );
  }

  // email_confirm: true is the whole point — it marks the address confirmed at creation, so
  // Supabase never attempts the mail that was timing out.
  const { data, error } = await service.auth.admin.createUser({
    email: address,
    password,
    email_confirm: true,
  });

  if (error) {
    const raw = (error.message ?? "").toLowerCase();
    // Don't echo Supabase's error text back to an anonymous caller; it varies by version and can
    // describe internals. Two cases are worth distinguishing for the person signing up, and the
    // rest collapse into one honest "we couldn't".
    if (raw.includes("already been registered") || raw.includes("already exists")) {
      throw new AccessError(409, "An account with that email already exists. Sign in instead.");
    }
    if (raw.includes("password")) {
      throw new AccessError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    console.error("[signup] createUser failed:", error.message);
    throw new AccessError(502, "Could not create the account. Try again in a moment.");
  }

  const created = data?.user;
  if (!created?.id) {
    console.error("[signup] createUser returned no user");
    throw new AccessError(502, "Could not create the account. Try again in a moment.");
  }

  // Exchange for a session using the *publishable* key, exactly as a browser sign-in would. The
  // service-role key must never be the thing that mints a user-facing token: a session derived
  // from it would not be a normal user session and RLS would not apply to it.
  const url = process.env.SUPABASE_URL!;
  const anon = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!anon) {
    throw new AccessError(503, "sign-up is not configured — SUPABASE_PUBLISHABLE_KEY is missing");
  }

  const browserClient = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: signInErr } = await browserClient.auth.signInWithPassword({
    email: address,
    password,
  });

  if (signInErr || !session?.session?.access_token) {
    // The account exists at this point, so this is recoverable by signing in — say that rather
    // than implying the sign-up failed and inviting a retry that will now 409.
    console.error("[signup] created the account but could not start a session:", signInErr?.message);
    throw new AccessError(502, "Account created, but sign-in failed. Try signing in.");
  }

  return {
    accessToken: session.session.access_token,
    refreshToken: session.session.refresh_token ?? null,
    user: { id: created.id, email: created.email ?? address },
  };
}
