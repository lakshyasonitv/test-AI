# Containerization phase — see docs/phases/PHASE_CONTAINERIZATION_REPORT.md.
#
# Base: the official Playwright image pinned to the same 1.49.0 the lockfile resolves
# (package-lock.json: node_modules/playwright@1.49.0). Browsers are pre-installed at
# /ms-playwright; PLAYWRIGHT_BROWSERS_PATH is already set there. Tag verified against
# the MCR registry on 2026-09-15 (v1.49.0-noble exists; no -jammy fallback needed).
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# /ms-playwright is where the base image installed the browsers; PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
# makes the `playwright install` postinstall a no-op in every layer, so `npm ci` never re-downloads
# (or worse, mutates) the pre-installed browsers.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Lockfile first, so dependency layers cache independently of source changes.
COPY package.json package-lock.json ./
# Full install on purpose: tsx and @playwright/test are runtime deps (the server runs
# TypeScript via tsx; executor.ts spawns node_modules/@playwright/test/cli.js). Do not --omit=dev.
RUN npm ci

COPY . .

ENV NODE_ENV=production PORT=3000

EXPOSE 3000

# Not `npm run serve`: --env-file-if-exists is Node-version-dependent and no .env exists in the
# image (docker-compose supplies it via env_file). Env vars set on the server process simply
# inherit into the Playwright child process executor.ts spawns.
CMD ["node", "--import", "tsx", "src/server/index.ts"]