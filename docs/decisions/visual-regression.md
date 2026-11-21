# Workstream: visual regression (TODO 16.1)

`pnpm visual` (`apps/web/visual`, `tools/visual`): every desktop screen and state against the HTML
references, light and dark, plus baselines for what has no mock. How to run and update it:
`tools/visual/README.md`.

## Decisions

| # | Decision | Reason |
|---|---|---|
| VRG-01 | **Full-frame comparisons, 0.05 % budget.** Every mocked state compares the whole 1440×900 frame (sidebar included) at pixelmatch threshold 0.1 with a budget of 0.05 % (≈650 px). Exceptions, each documented in its spec: avatars per size (≤1 % bust, ≤8 % head crops, measured ≤0.6 % / ≤6.6 %), the canvas's second thread crop (0.2 %, fractional y in the mock), card crops 0.1 % (measured ≤0.035 %). | After the fixes below every screen measures 0.000–0.007 %; a budget far above that would hide real regressions (the old 0.75–20 % budgets hid the ones fixed here). |
| VRG-02 | **Masks only for deliberate deviations, from the app's DOM.** `deviationMasks()` masks the boxes of `svg.lucide` (TP-14) and `svg[data-avatar]` (AV-02; avatars get their own spec) on both images; elements under a modal keep their mask outside the dialog only. One-off masks, each tied to a decision: C-07 ("1 channel"), D-07 (`whombat.com`), RA-03 (run actions at DONE), CE-10 (canvas thread 2, compared on its own), and the mock's impossible "Tue" RECENT labels. B-03 is handled by reporting macOS, live-scroll position by scrolling lists to the top. | Masks from hard-coded rectangles drift with layout; DOM boxes follow it and can't hide more than the deviating element. |
| VRG-03 | **Fixture-world differences are data patches, not masks.** Where the fixture world legitimately differs from the mock's hard-coded seed, the spec patches the app's query cache to the mock's data (`patchQueries`, `mock*.ts`): the "Needs you" row (web-push-connect.md, count → 0), RECENT rows (SW-02/SW-04/SW-11j), thread heads (SW-11f), run ticks, the audit log's rows / fingerprints / counts (SW-02, SW-04, C-04, the mock's 11:30), the approval's ready state, the plan gate label after a decision (the server's socket update), and the tick-8 sidebar. | Keeps every pixel of the screen compared while the rendering, not the seed, is under test. |
| VRG-04 | **Baselines for unmocked UI with `toHaveScreenshot`, one set for all platforms.** `snapshotPathTemplate` has no platform suffix; threshold 0.2, `maxDiffPixelRatio` 0.002. Baselines were taken on Debian 13 and pass unchanged in `mcr.microsoft.com/playwright:v1.63.0-noble`, which CI uses as its job container. Reads the fixture world does not serve (`repos.list`, `github.status`) are seeded in the cache (`seedQueries`). | Everything renders in web fonts with Playwright's own Chromium, so the images are platform-independent in practice; one set is simpler to review and update. |
| VRG-05 | **Storybook: Primitives/, Cards/, Foundations/ stories, both themes** (144 baselines), via the Storybook dev server as a second web server of the `visual` project, `?globals=theme:<t>`, 1200×800, clock frozen. One test per title; ids come from `index.json` at run time. Other story groups (App/, Runs/, Messaging/…) are screens already compared with the mock. | The task's scope (primitive / card stories) without duplicating the screen comparisons. |
| VRG-06 | **Determinism.** Frozen clock (2026-09-23 11:22 Europe/Amsterdam, `en-GB`, scale 1) on both sides; unpkg and Google Fonts through a disk cache with retries (`tmp/visual-cache`, `actions/cache` in CI) in the reference *and* the app; a failed reference render is retried from scratch; web fonts are awaited with `document.fonts.load()` of both families (lazy loading made "both loaded" impossible on pages without mono text, an empty result means the stylesheet is missing); the mock's live ticks are shot on their exact text; toasts are shot the moment they appear and checked to still be up. | Two full host runs (164 tests) and the baselines in the CI image passed with identical numbers. |
| VRG-09 | **Rendering independent of the machine.** Chromium runs with `--disable-lcd-text` for the references and the app (`CHROMIUM_ARGS`, `launchOptions`): subpixel text depended on fontconfig and compositing (the Ubuntu image drew the mock's toast with colour fringes, Debian never does). Where the *mock* draws a glyph missing from the Google Fonts subsets ("→" in "Full audit trail →"), the system fallback's metrics differ by OS (17 vs 18px line, 104 vs 106px wide): the spec pins the mock's line box to 17px and masks the link as the icon's slot (TP-14). The app's composer textarea had the same problem with `line-height: normal` and now uses the 19px the mock's input gets everywhere. | Verified: the full suite (164 tests) passes on Debian 13 and in `mcr.microsoft.com/playwright:v1.63.0-noble` with the same baselines and budgets. |
| VRG-07 | **CI: `.github/workflows/visual.yml`**, pull requests only, separate from `check`, in the Playwright image (tag = `@playwright/test`), `retries: 1` in CI, artifacts `tmp/visual/` + the Playwright report on failure. | Runs where the baselines were verified; `check` stays fast. |
| VRG-08 | **Reproducing CI locally**: `docker run --rm --network host -u $(id -u):$(id -g) -e HOME=/tmp -e PATH=<repo>/tmp/docker-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -v <repo>:<repo> -w <repo>/apps/web mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test --project=visual`, with `tmp/docker-bin/pnpm` a two-line shim (`[ "$1" = exec ] && shift; exec npx "$@"`) because the image has no pnpm. | Documented, not scripted: CI itself installs pnpm. |

## Fixes found by the suite

Real differences from the mock, fixed in the app (each now at 0.000 %):

- Human avatar initials were 1px high (`line-height: 1`; the mock uses the default line box).
- Agent profile: RIGHT NOW gap 8px (was 10), key notes 11px mono (was 12), Message/Watch run stretch to
  37px like the mock's flex row, RECENT header row 17px (the `<a>` was an inline 19px box), role line as
  three flex items ("Developer", "·", "Working" 6px apart).
- Roster card role label weight 500 (was 400). Dusty's channels in the mock's order (fixture data).
- Hire modal: KEYS label `padding-bottom: 4px`, "Hire {name}" 20px side padding.
- Link buttons ("Full audit trail →"): no gap before the arrow icon; Lucide's side bearing matches the
  mock's space.
- Audit log and search columns are left-aligned like the mock (they were centred); "Only {agent}" is two
  flex items 8px apart. The blocked merge of PR #479 has no deep link (the PR is not in the world: 404).
- Composer textarea line box 19px (see VRG-09).
- Canvas comments show the author's full name ("Mara Okafor"), as the mock binds `m.a.name`.
- Search: the fixture world answers the mock's question ("have we seen this invoice rounding error
  before?"), so the search box and the #incidents card's "Open in search" show the mock's text. This
  supersedes the "cosmetic query" note in audit-search.md; the server matches the seeded answer by the
  same string and ORs natural questions' terms, so real search behaves the same.
- Onboarding: Burrow HQ's onboarding (fixture) is named with Joris and Priya invited, as in the mock;
  back on step 1 the burrow's own name no longer reads "taken" and Continue moves on instead of creating
  the burrow again (regression test added); repo and invite rows keep their bottom border, invite emails
  in DM Mono, invite avatars in the mock's tone order; "Connect GitHub" sits 16px above the repo card as
  web-push-connect.md decided (it had the column's 32px gap plus 10px).
- Settings (not mocked, reviewed against the log / onboarding patterns): left-aligned column, names and
  states in the sans, mono only for repo names and emails, rows keep their borders.

## Follow-ups (outside this workstream)

- The "Needs you" sidebar row (web-push-connect.md) is not in the mock and shows in the seeded world at
  11:22 (one pending approval), pushing the user footer below the fold at 900px. The suite neutralises it
  through its data; whether it should stay is a product call.
- Fixture mode: `approve()` fast-forwards the storyline to DEPLOYED and decisions do not relabel plan
  cards (no socket); `agents.get` RECENT includes events after 11:22 (SW-11j). Screens are right on a
  seeded server; only fixture-mode demos show it.
