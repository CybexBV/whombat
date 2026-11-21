#!/usr/bin/env bash
# The apps' builds and browser journeys (CI job `app`): every web build the appliance and control ship, then the hosted
# app's journeys against the in-browser fake world, plain and under its strict CSP, then the real chat smoke test: a
# browser through the encrypted session to a disposable runtime and its runner, on the job's own Postgres
# (DATABASE_URL). Unit tests run in `check`.
set -euo pipefail
: "${DATABASE_URL:?the real chat smoke test needs the Postgres of the job in DATABASE_URL}"
pnpm install --frozen-lockfile --store-dir /srv/whombat-ci/cache/pnpm
pnpm build:web
pnpm build:web:hosted
pnpm build:widget
WHOMBAT_CONTROL_URL=https://api-dev.whombat.com pnpm build:embed
pnpm --filter @whombat/web exec playwright install chromium
# One Playwright process starts each selected project's server once and shares a total budget of four workers.
# Project names already distinguish test artifact folders; a single invocation never clears another run's output.
pnpm --filter @whombat/web exec playwright test --project=managed --project=hosted --workers=4 --output=../../tmp/playwright/web/app
# One real turn end to end, on a throwaway database next to DATABASE_URL that the runtime drops when it stops.
pnpm --filter @whombat/web exec playwright test --project=runtime --output=../../tmp/playwright/web/runtime
