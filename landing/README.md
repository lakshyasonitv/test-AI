# Testbench landing page

The marketing page, kept apart from the app so it can be hosted somewhere else (for example on
Hostinger) while the app keeps running in its Azure container. The two link to each other:

```
 testbench.space  (Hostinger, this folder)            Azure Container App (the app)
 ┌──────────────────────────────┐   "Start testing"  ┌──────────────────────────────┐
 │ index.html / landing.css /   │ ─────────────────▶ │ testbench....azurecontainer  │
 │ landing.js / .htaccess       │                    │ apps.io  (or app.yourdomain) │
 │                              │ ◀───────────────── │ top bar: "Landing page"      │
 └──────────────────────────────┘    LANDING_URL     └──────────────────────────────┘
```

| File | What it is |
|---|---|
| `index.html` | The page. Every "Start testing" / "Open the app" button links to the app's address |
| `landing.css`, `landing.js` | Its own style and script, loaded by relative path, so the page works in any folder |
| `media/` | The three demo videos and their poster images (about 85 MB). The page loads them from `media/` next to `index.html`, so this folder must be uploaded too |
| `.htaccess` | Optional: makes `testbench.space/app` redirect to the app. Read by Hostinger's web server |

The page never calls the app's API and never loads the app's files. The app does not serve this
folder.

## 1. Put the page on Hostinger

1. In hPanel open **Websites → your site → File Manager**, and go into `public_html`.
2. If Hostinger put a default page there (`default.php` or `index.php`), delete it.
3. Upload `index.html`, `landing.css`, `landing.js`, `.htaccess` and the whole `media` folder
   straight into `public_html` (not into a sub-folder), so you end up with `public_html/index.html`
   and `public_html/media/demo-1-website.mp4`. The easiest way is one zip: build it, upload it, then
   right-click it in File Manager and choose **Extract** (then delete the zip). The zip is about
   85 MB because of the videos; if File Manager refuses a file that size, upload the `media` files
   one by one, or use FTP from **Files → FTP Accounts**.

   Run this in PowerShell from the repository folder. It uses Windows' own `tar.exe`, not
   `Compress-Archive`: Windows PowerShell 5.1's `Compress-Archive` stores `media\demo-1-website.mp4`
   with a backslash, which Hostinger's Linux server extracts as one file with a backslash in its
   name instead of a `media` folder, and the videos then fail to load.

   ```powershell
   & "$env:WINDIR\System32\tar.exe" -a -c -f landing.zip -C landing index.html landing.css landing.js .htaccess media
   ```

4. In hPanel open **Security → SSL**, install the free certificate for the domain, and turn on
   **Force HTTPS**.
5. Open `https://testbench.space`. The page should load, and "Start testing" should open the app.

Do not use Hostinger's Git deploy with this repository. It would copy the whole project, source code
included, into `public_html`. Upload only the four files and the `media` folder above.

## 2. Landing page → app (already done)

Every "Start testing" button in `index.html` points at the app's dashboard (the one "Run a new test" button
points at the app's new-test screen, the same address ending in `#/`):

```
https://testbench.livelysmoke-6ad5557f.koreacentral.azurecontainerapps.io/#/dashboard
```

The dashboard appears only when the container has `DASHBOARD_ENABLED=true` (D-79). Without it the
same link simply opens the app's home screen, so the buttons work either way.

`.htaccess` also sends `https://testbench.space/app` there, which gives you a short address to share.
If the app's address changes (see step 4), replace that address in `index.html` and `.htaccess`, then
upload both again.

## 3. App → landing page

The app shows a **Landing page** link in its top bar only when `LANDING_URL` is set. Set it on the
Container App (this restarts the app once):

```bash
az containerapp update -n testbench -g testbench-rg --set-env-vars LANDING_URL=https://testbench.space/
```

Check that it took effect: `https://<app address>/api/health` should now include
`"landingUrl":"https://testbench.space/"`, and the link appears in the top bar after a reload. Leave
`LANDING_URL` unset and the app looks and behaves exactly as before. Only `http://` and `https://`
addresses are accepted. Anything else is ignored.

## 4. Optional: put the app on your own domain (`app.testbench.space`)

The app keeps working on its Azure address the whole time, so nothing breaks while you do this.

1. Find the verification ID and the Container Apps environment name:

   ```bash
   az containerapp show -n testbench -g testbench-rg --query properties.customDomainVerificationId -o tsv
   az containerapp show -n testbench -g testbench-rg --query properties.managedEnvironmentId -o tsv
   ```

   The environment name is the last part of the second result.

2. In hPanel open **Domains → your domain → DNS / Nameservers** and add two records:

   | Type | Name | Points to / content |
   |---|---|---|
   | CNAME | `app` | `testbench.livelysmoke-6ad5557f.koreacentral.azurecontainerapps.io` |
   | TXT | `asuid.app` | the verification ID from step 1 |

   Leave the records for the main domain alone, because they point at the Hostinger site.

3. Once DNS has updated (minutes to a few hours), attach the domain with a free certificate:

   ```bash
   az containerapp hostname add  -n testbench -g testbench-rg --hostname app.testbench.space
   az containerapp hostname bind -n testbench -g testbench-rg --hostname app.testbench.space --environment <environment-name> --validation-method CNAME
   ```

4. Switch everything that names the old address over to `https://app.testbench.space`:
   - `index.html` and `.htaccess` in this folder (then upload both again);
   - if Salesforce "Connect org" is on: `SALESFORCE_OAUTH_CALLBACK_URL`, and the same URL in the
     Salesforce Connected App's callback list;
   - if Jira is on: `JIRA_REDIRECT_URL`, and the same URL in the Atlassian console;
   - if sign-in is on (`AUTH_ENABLED`): add the new address to Supabase **Authentication → URL
     configuration** (Site URL and Redirect URLs).

   Change both sides of each pair together. A callback URL that matches on only one side makes that
   sign-in fail.

## Editing the page

- **Demo videos:** each `.lp-video` slot in `index.html` has `data-video="media/…mp4"` and
  `data-poster="media/…jpg"`. To swap a video, replace the file in `media/` (or point `data-video` at
  another address) and upload it again. An empty `data-video` keeps the coloured placeholder.
- **Preview locally:** open `index.html` in a browser. Nothing needs to be built.
- Every class on the page starts with `lp-`, and the page shares no CSS or JavaScript with the app.
