# eventrix.tech: create and publish a Technical Conference event

A worked prompt, kept for future runs. Written 2026-11-17 from what run
`2026-11-17T07-29-08-639Z-b4c58d1e` actually reached (`/events/create/new?template=Technical%20Conferences`).
Not a topic owner: the defect it works around is `TECH_DEBT.md` TD-194, the fix is `DECISIONS.md` D-85.

## Settings it needs (local `.env`)

```
MAX_DISCOVERY_PAGES=12      # /events/create is the 6th link from /home; the default crawl stops at 5
SCREEN_MODE_ALL_SITES=true  # capture each screen of the 6-step wizard live (D-85)
MAX_IR_ATTEMPTS=6           # each new wizard screen can cost one compile attempt
```

Restart the server after changing `.env` (`npm run serve` has no reload).

## URL

`www.eventrix.tech`

## Prompt

```
Log in with the given account. On the home screen click "Create Event" in the left sidebar.
On the template page choose "Technical Conferences".
Step 1 (Basics): in "Event Title" type "Jaipur Tech Summit Test". Under "Hosting Format" choose "Hybrid Format". Click "Continue".
Step 2 (Venue & Time): set the start date to 20 December 2026 and the end date to 21 December 2026. Type "Jaipur" as the location. Click "Continue".
Steps 3 to 5 (Limits & Specs, Questionnaire, Blueprint): keep every default and click "Continue".
Wherever a "Description" field appears, type: "Jaipur Tech Summit is a one day hybrid technical conference for developers, architects and students. Sessions cover cloud, AI and web engineering, with hands on workshops, expert talks, networking breaks and a closing panel on building reliable software at scale."
Step 6 (Review & Launch): click "Publish".
Check that the site confirms the event is published, and that "Jaipur Tech Summit Test" appears under "My Events".
```

## Why this wording, compared with the original request

| Original | Refined | Why |
|---|---|---|
| "identify the create event button" | "click 'Create Event' in the left sidebar" | The home page has both a sidebar link and a page button named Create Event. |
| "technical confrence template" | "Technical Conferences" | The site's exact label; the misspelling grounded on the "Conference" filter chip on /home. |
| "give the event a title" | a literal title | A value the test can type and later look for under My Events. |
| "make the event format hybrid" | "Hosting Format … Hybrid Format" | The site's own labels. |
| "use test dates" | two literal future dates | A model cannot guess a date the site accepts; a past date is commonly rejected. |
| "add description of minimum 30 words" | a literal 40-word text | Counted words are a guess; a literal is checkable. |
| "leave everything as default" | "keep every default and click Continue" on steps 3–5 | Names the click that moves the wizard on, so each screen is reached and captured. |
| "check it is creating an event" | a confirmation **and** My Events | Two observable outcomes instead of one vague one. |

Each published run creates a real event on the live site. Delete the test events afterwards from My Events.

## Do not mention the popups

Run `2026-11-17T08-07-06-463Z-c41cebba` asked to click "Maybe Later" on the "Enable Notifications" popup. The popup
was not on screen when the compile replayed the steps (it appears late, or once), and a Testbench test has no
"if it appears" step, so that step could never ground and spent an attempt. The popups sit beside the form, not
over its fields; leave them alone.
