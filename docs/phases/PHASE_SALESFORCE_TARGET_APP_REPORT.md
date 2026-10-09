# Phase — the Salesforce checkbox now does something

`PHASE_SALESFORCE_RUN_FLAG_REPORT.md` added a checkbox and a run-scoped accessor,
`currentRunTargetApp()`, and made nothing read it. This phase is the reader (`DECISIONS.md` D-51).

For a run with "This URL is a Salesforce org" ticked: discovery uses the live-DOM walker whatever the
global flag says, the planner / test-case / IR prompts gain Salesforce guidance, and the discovery
caches are keyed so a ticked and an unticked run never share a model. Every other run is unchanged.

**Tests:** `tsc` clean. vitest **1941 passed**, 1 failed (`safeClickBrowser`, needs `example.com`),
23 skipped; 1922 before this phase, so +19, all new.

## 1. WHAT CHANGED

| File | Why |
|---|---|
| `src/stages/salesforceGuidance.ts` | **New.** The guidance text per stage and `salesforceGuidance(stage)`, which is `""` unless the run's target app is Salesforce. Each rule names the deterministic check behind it, or says there is none. |
| `src/stages/domDiscovery.ts` | `elementStrategy()` returns `"live"` for a Salesforce run. |
| `src/stages/liveDomDiscovery.ts` | Tags elements inside an open dialog (across shadow hosts): `pageSection` / `containerRole: "dialog"`, `containerName`. |
| `src/stages/planner.ts`, `testCases.ts`, `ir.ts` | `const system = baseSystem + salesforceGuidance(stage)`. The base text is untouched. |
| `src/stages/hybridDiscovery.ts` | `siteCacheKey` and the bare-URL key gain a `#live` suffix for the live strategy; `siteCacheKey` is exported for the test. |
| `tests/salesforceTargetApp.test.ts`, `tests/fixtures/salesforceTarget/null-run-prompts.json` | The pins below. |
| `DECISIONS.md` D-51, `TECH_DEBT.md` LS-6 / LS-7 | Rationale and open debt. |

`ir.ts` and `hybridDiscovery.ts` are Garvit's files; edited with the stream owner's explicit approval.

## 2. NEW ENV FLAGS / ROUTES / SCHEMA

**None.** Reuses `SALESFORCE_ENABLED` (D-50) and `DISCOVERY_LIVE_DOM`. No route or schema change.

## 3. HOW IT WAS VERIFIED

- **An ordinary run is byte-identical.** The system prompt each stage sends was captured from the code
  BEFORE the change and committed; the test asserts today's prompt equals it, outside a run and inside
  a run with no target app. The LLM cache key hashes the prompt, so those keys are unchanged.
- **A Salesforce run is base + guidance, appended.** Asserted per stage.
- **Separate cache entries.** The same plan input in an ordinary and a Salesforce run costs one model
  call in each mode, not one in total.
- **Every mechanism mutation-checked:** guidance never appended / appended to every run; the checkbox
  not selecting the walker; hybrid keys ignoring the strategy; the plan cache key ignoring the
  guidance; the IR or test-case stage not wired; dialog tagging dropped — each fails a test.
- **Real browser:** a Salesforce run with `DISCOVERY_LIVE_DOM` unset sees shadow-DOM content an
  ordinary run does not; a modal's Save is told apart from the page's Save, including a dialog whose
  controls sit under nested shadow roots.

## 4. HOW TO ROLLBACK

`git revert` the commit. Or, without reverting: untick the box / leave `SALESFORCE_ENABLED` off — a
null run takes none of these paths.

## 5. DELIBERATELY NOT DONE

- **Never run against a live Salesforce org** (LS-7). The guidance is general Lightning knowledge; its
  wording of Salesforce's own messages is the least certain part.
- **Only three prompts** (LS-6): failure diagnosis, concept labelling, classification and the editor's
  change route get no Salesforce context.
- **A Salesforce-specific wait for slow Lightning pages.** `DISCOVERY_HYDRATION_POLL_MS` still applies
  only to a page that extracted zero elements.
- **TD-112** (a run that lands on Lightning is reported "blocked") and the first-screen credential
  prompt not appearing on a real org are other streams' and still open.
- **Cross-origin frames** (Visualforce, some Setup pages) are still skipped by the walker.
