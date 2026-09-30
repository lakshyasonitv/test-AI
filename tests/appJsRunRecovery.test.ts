import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The run view's poll loop, and the sign-out guard, in `public/app.js`.
 *
 * WHAT BROKE, and why it was a RENDER defect rather than a retry defect.
 *
 * `connectToRun` polls `GET /api/runs/:id/state` once a second and applies only what it has not
 * seen: `events.slice(seen)`, with `seen` a closure counter that only ever moves forward. The retry
 * was always correct — the counter resets on the next good read — but the run view was never
 * rebuilt when the connection came back. So anything the run emitted *while the network was down*
 * stayed unapplied forever: the stage cards sat on PENDING with no remaining event to move them,
 * and only a page reload recovered (a reload resets `seen` to 0 and replays the whole stream).
 *
 * THAT is what these tests pin. On the first good read after a failure, the run view is thrown
 * away and the full stream re-applied — deliberately the reload path, not a new mechanism, since
 * `applyEvent` is already re-appliable from the start (the reload view depends on it).
 *
 * The status branching exists because `res.ok` was never consulted at all: a 403, a 404, a 500 and
 * a dropped connection all reached the same `catch`, and the loop retried a permanently-failed
 * request at 1Hz with no end. 403 is the subtle one — `requireRunRole` in src/server/authz.ts
 * raises it when a run has no provable ownership record, which is exactly what a run pruned by
 * retention looks like, and signing in again cannot fix it.
 *
 * `public/app.js` is a classic script with no module surface, so the functions under test are
 * extracted from the file and evaluated against stubs, the same technique as
 * `tests/appJsNewRunBtn.test.ts` and `tests/stepText.test.ts`. Every DOM-free dependency is
 * stubbed, so these run with no browser, no server and no network.
 */

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

/**
 * Strip `//` line comments so a source assertion finds CODE, not prose.
 *
 * Same reason as `tests/appJsNewRunBtn.test.ts`: several assertions below look for a call that
 * sits directly beside a comment naming the same function, so a search over raw source finds the
 * documentation whether or not the code is present. That file shipped a test that passed with
 * its own fix deleted for exactly this reason.
 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      return i < 0 ? line : line.slice(0, i);
    })
    .join("\n");
}

/** Slice a top-level `function name(...)` — plain or `async` — out of app.js by brace matching. */
function extractFunctionSource(name: string): string {
  const m = new RegExp(`(?:async )?function ${name}\\(`).exec(APP);
  if (!m) throw new Error(`${name} not found in public/app.js`);
  const body = APP.slice(m.index);
  let depth = 0;
  for (let i = body.indexOf("{"); i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) return body.slice(0, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

/** A fake server response. `body` is what `res.json()` resolves to. */
function resp(status: number, body: unknown) {
  return { status, json: async () => body };
}

const POLL_SOURCES = `${extractFunctionSource("stopRunPolling")}\n${extractFunctionSource("connectToRun")}`;

interface PollHarness {
  /** Every event handed to `applyEvent`, in application order. */
  applied: unknown[];
  /** How many times the loop asked the server. */
  polls: () => number;
  /** How many times the run view was thrown away and rebuilt. INCLUDES the one reset `connectToRun`
   *  does on entry, so a healthy run reads 1 and a recovering run reads 2 — the two tests below
   *  pin both numbers, which makes the entry reset itself a checked quantity rather than noise. */
  resets: () => number;
  /** Verdicts painted, in order — `head` is what the user is shown. */
  verdicts: { head: string; detail?: string }[];
  /** The live values `connectToRun` and `stopRunPolling` wrote. */
  state: () => { returnToRunAfterSignIn: string | null; currentRunId: string | null; authScreen: string };
  /** Resolves when the loop has exited. */
  done: Promise<void>;
}

/**
 * Run the real `connectToRun` against a scripted sequence of server answers.
 *
 * TERMINATION. The loop's only exits are a generation change or a terminal event, and neither is
 * reachable from a stub, so the harness ends the script by bumping the generation: once the
 * scripted responses run out, the next fetch bumps `pollGeneration` and the following `while`
 * check fails. That is a real exit through the real condition, so nothing about the loop's control
 * flow is faked. The inter-poll `setTimeout` is injected as a zero-delay, so the 1s gap costs
 * nothing and the whole thing settles on the microtask queue.
 */
function runPoll(responses: (() => unknown)[]): PollHarness {
  const applied: unknown[] = [];
  const verdicts: { head: string; detail?: string }[] = [];
  const counters = { polls: 0, resets: 0 };

  // `deps` holds everything injected; the two module-level `let`s the code WRITES
  // (`pollGeneration`, `currentRunId`, `returnToRunAfterSignIn`) are declared as real bindings
  // inside the evaluated scope instead, because a parameter cannot be written back to.
  const factory = new Function(
    "deps",
    "setTimeout",
    "runId",
    `
    const {
      fetch, document, refreshNewRunState, resetRunUI, applyEvent,
      submitBtn, finalResult, verdictEl, icon, paintVerdict, setSession, applyRoute
    } = deps;
    let pollGeneration = 0;
    let currentRunId = null;
    let returnToRunAfterSignIn = null;
    const auth = { screen: "run" };

    ${POLL_SOURCES}

    return {
      started: connectToRun(runId),
      // The harness ends the script by bumping the generation, which is the only way the loop
      // retires — so it needs a handle on the very binding the loop compares against.
      bump: () => { pollGeneration++; },
      state: () => ({ returnToRunAfterSignIn, currentRunId, authScreen: auth.screen }),
    };
    `,
  );

  const el = {
    classList: { remove() {}, add() {} },
    textContent: "",
    innerHTML: "",
    disabled: false,
  };

  // Assigned by the factory; only ever CALLED from the fetch stub, which cannot run before
  // `factory(...)` has returned.
  let bump!: () => void;

  const fetchStub = async () => {
    const i = counters.polls++;
    if (i >= responses.length) {
      bump();
      return resp(200, []);
    }
    return responses[i]();
  };

  const built = factory(
    {
      fetch: fetchStub,
      document: {
        getElementById: (id: string) =>
          id === "loginError"
            ? { textContent: "", classList: { remove() {}, add() {} } }
            : null,
      },
      refreshNewRunState: () => {},
      resetRunUI: () => { counters.resets++; },
      applyEvent: (e: unknown) => { applied.push(e); return false; },
      submitBtn: el,
      finalResult: el,
      verdictEl: el,
      icon: () => "<svg/>",
      paintVerdict: (v: { head: string; detail?: string }) => { verdicts.push(v); },
      setSession: () => {},
      applyRoute: () => {},
    },
    // Zero-delay stand-in for the 1s inter-poll sleep.
    (fn: () => void) => fn(),
    "run-abc",
  );

  bump = built.bump;

  return {
    applied,
    polls: () => counters.polls,
    resets: () => counters.resets,
    verdicts,
    state: built.state,
    done: Promise.resolve(built.started).then(() => undefined),
  };
}

describe("public/app.js — the run poll loop", () => {
  it("a 401 STOPS the loop rather than retrying it", async () => {
    // A 401 can never become a 200 by waiting. The old code never looked at the status, so this
    // was parsed as an event array — or, failing that, caught and retried at 1Hz for as long as
    // the tab stayed open.
    const h = runPoll([() => resp(401, { error: "authentication required" })]);
    await h.done;

    expect(h.polls(), "a terminal status must not be retried").toBe(1);
    expect(h.applied.length, "an error body is not an event stream").toBe(0);
    expect(
      h.state().returnToRunAfterSignIn,
      "401 must preserve the run, so signing in again returns to THIS run rather than home",
    ).toBe("run-abc");
    expect(h.state().authScreen, "401 must land on the sign-in screen").toBe("login");
  });

  it("a 401 says the session expired", async () => {
    const h = runPoll([() => resp(401, { error: "authentication required" })]);
    await h.done;
    expect(h.verdicts.map((v) => v.head)).toContain("Your session expired");
  });

  it("a 404 STOPS the loop and says the run is no longer available", async () => {
    // `/state` does not 404 today — it answers `200 []` for a missing directory — so this is the
    // defensive branch. It is here so a future route change cannot drop a missing run into the
    // transient path and poll it at 1Hz forever.
    const h = runPoll([() => resp(404, { error: "not found" })]);
    await h.done;

    expect(h.polls()).toBe(1);
    expect(h.verdicts.map((v) => v.head)).toContain("This run is no longer available");
  });

  it("a 403 STOPS the loop and does NOT route to sign-in", async () => {
    // THE INTERESTING ONE. `requireRunRole` raises 403 when a run has no provable ownership
    // record, which is what a run deleted by retention looks like — and also what a run in another
    // organisation looks like. Signing in again cannot fix either, so treating 403 as "session
    // expired" would bounce a legitimate second-org user to the login screen forever, where
    // re-authenticating lands them on the same 403.
    const h = runPoll([
      () => resp(403, { error: "you do not have access to this run" }),
    ]);
    await h.done;

    expect(h.polls()).toBe(1);
    expect(h.verdicts.map((v) => v.head)).toContain("This run is no longer available");
    expect(
      h.state().returnToRunAfterSignIn,
      "403 must not send the user to sign in — no amount of signing in grants access to a " +
        "deleted or someone else's run",
    ).toBeNull();
  });

  it("a 5xx is TRANSIENT — it keeps retrying instead of stopping", async () => {
    // The other half of the branch, and the one that must not regress: an overloaded server is
    // exactly the case the retry exists for.
    let attempts = 0;
    const h = runPoll([
      () => { attempts++; return resp(503, { error: "overloaded" }); },
      () => { attempts++; return resp(503, { error: "overloaded" }); },
      () => { attempts++; return resp(200, [{ stage: "plan", status: "completed" }]); },
    ]);
    await h.done;

    expect(attempts, "a 5xx must be retried, not treated as terminal").toBeGreaterThan(1);
    expect(
      h.verdicts.map((v) => v.head),
      "two failures is well under the threshold, so nothing is painted yet",
    ).toEqual([]);
  });

  it("RECOVERY REPLAYS THE WHOLE STREAM, not just what was missed", async () => {
    // THE MAIN REGRESSION. Before this, `seen` only moved forward: an event emitted while the
    // connection was down had nothing re-deriving it, so its stage card stayed on PENDING until a
    // page reload.
    //
    // Asserted on the event applied BEFORE the outage being applied a SECOND time — that
    // re-application is what "replay from zero" means, and what a reload already does.
    const before = { stage: "plan", status: "completed" };
    const during = { stage: "discovery", status: "completed" };
    const h = runPoll([
      () => resp(200, [before]),
      () => resp(500, { error: "boom" }),
      () => resp(200, [before, during]),
    ]);
    await h.done;

    expect(
      h.resets(),
      "the run view must be thrown away and rebuilt on the first good read after a failure — " +
        "two resets total: the one connectToRun does on entry, plus the recovery rebuild",
    ).toBe(2);

    const planCount = h.applied.filter(
      (e) => (e as { stage: string }).stage === "plan",
    ).length;
    expect(
      planCount,
      "the pre-outage event must be applied a second time — that re-application IS the recovery",
    ).toBeGreaterThan(1);
    expect(h.applied, "the event emitted during the outage must be applied").toContainEqual(during);
  });

  it("does NOT replay when nothing failed", async () => {
    // The guard on the fix above. Replaying on every poll would reset the run view once a second
    // and make the live run flicker instead of update.
    const h = runPoll([
      () => resp(200, [{ stage: "plan", status: "completed" }]),
      () => resp(200, [{ stage: "plan", status: "completed" }]),
      () => resp(200, []),
    ]);
    await h.done;

    expect(
      h.resets(),
      "a healthy poll must not rebuild the run view — one reset, the entry one, and no more",
    ).toBe(1);
  });

  it("the 'lost contact' threshold is a floor, not exact equality", async () => {
    // `if (++fails === 5)` only ever worked because a success reset the counter to 0. Anything
    // that skipped a tick lost the message permanently, and the sixth and later failures were
    // never reported at all. A floor states the intent: enough consecutive failures, say so.
    const source = stripLineComments(extractFunctionSource("connectToRun"));
    expect(
      source.includes("++fails >= 5"),
      "the threshold must be a floor (>=) — exact equality silently drops the message whenever " +
        "the counter does not land on precisely 5",
    ).toBe(true);
    expect(
      /if \(done\) \{\s*fails = 0;/.test(source),
      "fails must be cleared when the run finishes, or a terminal run leaves it set for the next one",
    ).toBe(true);
  });

  it("the generation is re-checked after the fetch and BEFORE the response is acted on — TD-15", async () => {
    // Run A's poll is in flight; the user switches to run B. The stale response must not be acted
    // on at all with A's id still closed over. This is the only item in the register that can
    // misdirect a secret — a credential modal for run A popping over what the user believes is
    // run B.
    //
    // The assertion is ORDER, and specifically it must be the recheck that comes before the status
    // branch, not merely "a recheck exists somewhere later in the function". There are two
    // recheck sites in connectToRun — one after the fetch, one after res.json() — and pinning only
    // the looser one lets the meaningful one be deleted while the test stays green.
    const source = stripLineComments(extractFunctionSource("connectToRun"));
    const fetchAt = source.indexOf("await fetch(");
    expect(fetchAt).toBeGreaterThan(-1);

    const recheckAt = source.indexOf("generation !== pollGeneration", fetchAt);
    expect(
      recheckAt,
      "a generation re-check must follow the awaited fetch",
    ).toBeGreaterThan(fetchAt);
    expect(
      recheckAt,
      "…and must come BEFORE the status branch, so a stale response cannot branch on its status",
    ).toBeLessThan(source.indexOf("stopRunPolling(runId"));
    expect(
      recheckAt,
      "…and before the body is parsed, so a stale response is never applied",
    ).toBeLessThan(source.indexOf("await res.json()"));
  });
});

describe("public/app.js — signing out", () => {
  it("signOut bumps pollGeneration, so an in-flight poll stops", () => {
    // Without this the running loop keeps polling /state with a token that is about to be revoked.
    // Each 401 is then swallowed by the same transient catch a dropped connection uses, so
    // signing out manufactures a 1Hz self-inflicted outage that reads as the server falling over.
    const source = stripLineComments(extractFunctionSource("signOut"));
    expect(
      source.includes("pollGeneration++"),
      "signOut must bump pollGeneration — an in-flight connectToRun is retired only by a " +
        "generation change, and nothing else here touches it",
    ).toBe(true);
  });

  it("confirms ONLY when a run is active, and decides it client-side", () => {
    const src = stripLineComments(APP);
    const idx = src.indexOf("A test run is still in progress");
    expect(idx, "the confirm must name what is at stake").toBeGreaterThan(-1);

    const around = src.slice(Math.max(0, idx - 700), idx + 300);
    expect(
      /currentRunId\s*&&\s*!currentRunFinished/.test(around) && around.includes("runInFlight"),
      "the condition must be `currentRunId && !currentRunFinished`, plus runInFlight — all " +
        "client-side, so confirming costs no server round trip",
    ).toBe(true);
    expect(
      around.includes("confirm("),
      "native confirm() — all six other destructive asks in this file use it, and a styled " +
        "modal would mean minting a CSS class (platform rule 3)",
    ).toBe(true);
  });

  it("the bare always-ask is gone, not merely supplemented", () => {
    // Guards against reverting to the shape this replaced. Asking when nothing is at stake — a
    // finished run, the home screen — is the defect, so a second confirm() alongside the
    // conditional one would reintroduce it.
    expect(
      stripLineComments(APP).includes('confirm("Sign out?")'),
      "the unconditional confirm(\"Sign out?\") must be replaced rather than kept alongside",
    ).toBe(false);
  });
});
