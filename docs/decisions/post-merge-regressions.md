# Post-merge regressions (accessibility, states, visual-regression, security fixes)

Two regressions appeared once these branches were merged into main: failing `pnpm visual` specs and the
CI failure of e2e "take over stops the agent and hands the run to the person". Each is traced to the change
that caused it below. The app and the server were fixed. The only baselines added are for stories that had none.

| # | Symptom | Cause | Fix |
|---|---|---|---|
| PM-01 | `agents.spec` (roster + each profile, overlay pane at 1200, hire modal): ~1.5 % of the frame, profile pane shifted down 22–43 px | bc76d93 (accessibility) changed the profile name from a `<span>` to an `<h2>` so the pane has a heading. The CSS-module class did not reset the h2's default `margin-block` (0.83em) | `margin: 0` on `.name`. The `<h2>` stays |
| PM-02 | `baselines.spec` "settings, GitHub connected": 17 664 px, "Couldn’t load repos." where the repos list should be | 5b4b222 (states) renders `ErrorNote` whenever `query.error` is set, even when data is loaded. In fixture mode `repos.list` 404s. The spec seeds the data, but the query's retry then fails and sets `error` | **Decision:** the error note is only for a first load that failed. With data on screen, a failing refetch keeps the data (`error && !data`). Applied to settings (repos, members), roster, audit log, canvases, canvas and search. Unit test in `SettingsScreen.test.tsx` |
| PM-03 | `stories.spec` Primitives/ListState (light, dark): "snapshot doesn’t exist" | 3bcaf61 (states) added the ListState stories after the visual suite took its baselines | Baselines added after review. They show the new primitives as intended |
| PM-04 | CI e2e: take over reached the runner as `{ outcome: 'cancelled', reason: 'cancelled' }` instead of `taken_over` | 8ee9433 (lease check). When `progress`'s lease renewal matched no row, it answered `cancel` with the stop reason it had read before the update. A Pause or Take over that committed while the renewal waited for the dispatch row lock therefore became a plain `cancelled`. Before this change the renewal result was ignored, and the next beat reported the real reason | The code was wrong and the test was right: security-fixes.md keeps take-over semantics, and only a lost lease is a bare `cancelled`. When the renewal matches nothing, `progress` now re-reads the row: a lost lease answers `cancelled`, anything else answers the row's current stop reason. Deterministic test in `runner.int.test.ts`: the take over's writes hold the row until the beat is seen waiting on the lock (`pg_stat_activity`) |

The visual suite has intermittent timeouts on this machine: "waiting for `#storybook-root > *`" and onboarding
"STEP 2 OF 4". The traces show `net::ERR_NETWORK_CHANGED` from the host's shifting Docker networks, not from
the app. They pass on rerun.
