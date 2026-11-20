# How live "record a flow" tools work, and what Testbench copied

Research done 2026-11-20 for the live-browser recorder (`docs/phases/PLAN_RECORD_ONCE.md`, option C).
Playwright details are from the v1.49.0 source; product claims are from each vendor's own docs. Points
that could not be confirmed are marked (unverified).

## Live view
- **CDP screencast** (`Page.startScreencast`) is what most server-side tools start with. Steel measured it
  at 4–12 fps and moved to WebRTC at 25 fps because screencast also misses native `<select>` popups and
  dialogs. https://steel.dev/blog/webrtc
- Every frame must be acked (`Page.screencastFrameAck`) at once, or the stream stops. A page that does not
  repaint sends no frames, so keep the last one.
  https://chromium.googlesource.com/devtools/devtools-frontend/+/main/front_end/core/sdk/ScreenCaptureModel.ts
- Reflect "screen shares" a cloud browser into its app; Browserless and Steel offer an embeddable live URL
  (Steel warns the URL itself is not access control). Ghost Inspector records with an extension; mabl moved
  from an extension to a desktop app (unverified).
  https://docs.steel.dev/overview/guides/view-and-embed-live-sessions
- Polling over HTTP is fine for click-and-wait recording; drag and hover menus want a WebSocket later.

## Input
- Send coordinates as fractions of the picture against a fixed viewport, and replay them with
  `page.mouse` / `page.keyboard` (trusted events, button and modifier state handled).
- Text should come from a local input box's `input` event (`keyboard.insertText` on the server), not from
  key events — that is what keeps IME, paste and dictation working. Named keys go as `keyboard.press`.
  https://github.com/microsoft/playwright/issues/5777
- Native `<select>` dropdowns, alerts and file pickers are not in the frames: show the options in the app,
  accept dialogs on the server.

## Capturing what was done (Playwright codegen, v1.49)
- Locator priority: test id → placeholder / label → role + name → alt → text → title → CSS; the first that
  matches exactly one element wins; `nth` only as a last resort.
  https://github.com/microsoft/playwright/blob/v1.49.0/packages/playwright-core/src/server/injected/selectorGenerator.ts
- Checkbox / radio clicks become check; `<select>` becomes selectOption; repeated fills of one box collapse
  into the last; a navigation right after a click belongs to that click, not its own step; there are
  assertion modes (visible, text, value). recorder.ts, recorderUtils.ts, recorderCollection.ts in the same tree.

## Security
- Checking a URL before navigating is not enough: Chromium resolves DNS again (rebinding), and redirects and
  sub-resources can reach `169.254.169.254`. The complete fix is an egress proxy that resolves names itself
  and refuses private / link-local addresses (Stripe's Smokescreen is the usual reference, unverified).
  https://21pdf-marketing.pages.dev/blog/ssrf-pdf-renderers
- Passwords: never record the value; reference it (`${env:...}`).
- One context per recording, owned by one user; idle timeout; a cap on concurrent sessions; downloads and
  `file://` blocked.

## What Testbench v1 does (branch `feat/recorder`)
| Topic | Choice |
|---|---|
| Live view | CDP screencast, JPEG q60, 1280×720, ack first, latest frame only, polled with `?after=<seq>` (204 when unchanged) |
| Input | fractions → `page.mouse`; a hidden textarea's `input` event → `insertText`; named keys → `press`; wheel |
| Naming | **resolved on the server before the action runs**: Chromium's accessibility tree gives role + exact name, then the same Playwright locator the generated spec uses is checked for uniqueness (`nth` when needed); test id / label / placeholder / text only when unique. No script is injected into the site, so CSP never applies |
| Steps | one fill per box, focus click dropped, checkbox → check, `<select>` → options shown in the app, Check mode → visible / text check, new tab → followed |
| Secrets | a password box is `${env:TEST_PASSWORD}`; the box before it `${env:TEST_USERNAME}`; typed text is never logged or stored |
| Network | http/https/data/blob only; every host resolved and refused if any address is private, loopback, link-local or metadata; service workers and downloads blocked. Known gap: DNS rebinding — an egress proxy is a follow-up |
| Limits | 2 sessions per server, 10 min idle, 30 min hard cap, browser closed on save / cancel / leaving the page |

**Deferred:** WebSocket/WebRTC streaming, drag and drop, hover-only menus, file upload, cross-origin
iframes, an egress proxy, recording on a separate worker.
