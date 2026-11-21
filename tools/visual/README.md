# @whombat/visual-tools

Reference screenshot harness. Renders the design references in
`docs/design-handoff/design/*.dc.html` with Playwright chromium so UI work can be compared
pixel-for-pixel against the mocks. The design references are internal and not part of the public
mirror, so `pnpm ref:shot` and the comparisons against the mock don't run from it.

How it works: the design directory is copied to a temp folder (the references need `support.js`
and sibling components such as `WhombatAvatar.dc.html` next to them), the prop defaults in the
`data-props` JSON on `<script data-dc-script>` are rewritten, the copy is served over a local static
server, and chromium opens it. React and Babel load from unpkg and fonts from Google Fonts; both go
through a disk cache in `tmp/visual-cache/` (fetched with retries on a miss, then served offline;
`WHOMBAT_VISUAL_CACHE` moves it, deleting it refetches). It waits for the render, network idle and the
web fonts (Bricolage Grotesque and DM Mono actually loaded, not a fallback), performs the clicks in
order, then screenshots; a render that fails is retried from scratch. The clock is frozen at
Wednesday 23 September 2026 11:22 Europe/Amsterdam (disable with `--no-freeze`).

First time: `pnpm --filter @whombat/web exec playwright install chromium`.

## `pnpm visual` — the regression suite

`apps/web/visual/*.spec.ts` (Playwright project `visual`). Two kinds of checks:

1. **Against the mock.** Each spec renders the reference with `shootReference` and the web app in
   fixture mode (`VITE_FIXTURES=1`, no server) at the same viewport and theme, then diffs them with
   `pixelmatch`. Budgets are tight (0.05 % of the compared region; per size for avatars) and the
   only masks are documented deliberate deviations (below). The mock's sidebar is the crew's and the app's
   the one agent's shell (Whombat one-agent.md OA-03), so a screen with the sidebar is compared on its main
   column (`mainRegion`; app docs/decisions/hermes-engine-app.md AP-5100).
2. **Baselines** for what has no mock, or whose mock is the crew's (its agents' names, rows, owners and
   channels, which the one-agent screens can't match; AP-5102): `baselines.spec.ts` (`/settings`, the Vault, the
   three onboarding steps), `audit.spec.ts`, `messaging.spec.ts` (the branch room), `search.spec.ts`,
   `canvas.spec.ts` and `stories.spec.ts` (every Storybook story under Primitives/, Cards/ and Foundations/). They
   use `toHaveScreenshot`; the PNGs live in `apps/web/visual/__screenshots__/`.

Coverage, light and dark, 1440×900 unless noted:

| spec | states |
|---|---|
| `cards` | every chat card state the mock reaches (plan, research, run live/done, review, commits, pill, approval pending/waiting/ready/declined/deployed, receipts) |
| `run` | run page at live ticks 0, 3, 5 and 8 (RUN · DONE), main column |
| `approval` | the approval dialog, "Approve in advance" and "Approve and deploy" (over the branch room; the mock's channel went with one agent) |
| `toasts` | "Approved in advance", "Declined", each toast alone |
| `avatars` | each face at 160, 64, 40 (bust), 32 (head), 24 and 16 (small head), light and dark, against the crew's reference (`docs/design-handoff/whombat-crew/reference/crew-reference.html`, `shootCrewReferenceElements`) |
| `messaging` | baselines: branch room Conversation + Files changed, branch overlay pane at 1200 |
| `search` | baselines: the mock's question with the answer, and each type filter |
| `canvas` | baselines: plan canvas at 1440 and 1100 |
| `audit` | baselines: default (e-9f18 open), Agents + Code, expanded blocked row, expanded decided ask |
| `baselines` | settings (General, GitHub connected and not, AI, Spend, Agent), the Vault, the three onboarding steps, the sign-up name step |
| `stories` | Storybook Primitives/, Cards/, Foundations/ stories |
| `skills` | baselines: Settings → Skills (the list, a changed built-in, a hub skill with an update), Add skills on Hermes's hub (browsing, a preview allowed and one blocked) |
| `voice` | baselines: This Whombat's VOICE TYPING (Fast ready, Most accurate failed, a graphics chip), Chat's composer with the mic and recording |

### Running

```sh
pnpm visual                                   # everything (starts Vite in fixture mode and Storybook)
pnpm visual canvas.spec.ts                    # one spec
pnpm visual -g "plan canvas"                  # by test title
WEB_VISUAL_PORT=5641 STORYBOOK_VISUAL_PORT=6641 pnpm visual   # other ports (parallel agents)
```

The specs open burrow screens by their burrow-less paths (`/pr/482`, `/settings?tab=ai`); the fixture world
has one burrow, so that is the one they show. An old `/burrow-hq/…` path works too: the app redirects it (AP-363).

Each mock comparison writes `tmp/visual/<name>-{reference,mine,diff}.png` (red pixels differ, magenta
is masked) and prints its mismatch; failures also attach the three images to the Playwright report
(`tmp/playwright/web/`). Servers are reused when already running locally, never in CI.

### Updating

- A mock comparison fails: look at `tmp/visual/<name>-diff.png`, fix the app. Only raise a budget or
  add a mask for a deviation that is written down as a decision, and document it in the spec's header.
- A baseline fails after an intended change: `pnpm visual --update-snapshots` (optionally with the
  spec file), review the changed PNGs in `apps/web/visual/__screenshots__/` and commit them.
- New screen state: add it to the spec of its area; use `setReferenceState` for mock states no click
  reaches and `patchQueries`/`seedQueries` for fixture data (see `support/harness.ts`).

### Determinism

- Clock frozen at 2026-09-23 11:22 Europe/Amsterdam in both browsers, `en-GB`, device scale 1.
- Chromium runs with `--disable-lcd-text` (grayscale text on every machine; `CHROMIUM_ARGS`).
- The app's theme comes from `localStorage`, the platform reports macOS (B-03, ⌘K).
- Every shot waits for network idle, the web fonts and two animation frames; animations are disabled.
- unpkg and Google Fonts come from the disk cache (retries on a miss), in the reference and in the app.
- Live-scroll position: conversation and thread lists are scrolled to the top (the mock never scrolls).
- The mock's live ticks are shot with `waitFor` (the exact tick's text), not a sleep.
- Baselines use one set for every platform (web fonts only); CI runs in
  `mcr.microsoft.com/playwright:v1.63.0-noble` (the tag must match `@playwright/test`). To reproduce CI
  locally, run the suite in that image with a `pnpm` shim.

### Deliberate deviations (the only masks)

- **Lucide icons** in the mock's placeholder-glyph slots (TP-14):
  every `svg.lucide` box.
- **Agent avatars** (SVG port of the CSS avatars, AV-01/AV-02): every `svg[data-avatar]` box; the
  avatars themselves are compared in `avatars.spec.ts`.
- **The Whombat logo** in the mock's ellipse-and-text slots (sidebar, onboarding aside; BR-01): every
  `svg[data-logo]` box.
- At RUN · DONE the run header's buttons (RAP-03).
- Where the mock names a channel or a crew member and the app a room or a person (Whombat one-agent.md OA-01,
  OA-04): the run page's back link and “Asked by …” line (`lineMasks`: the line to its parent's right edge), and
  the run's keys (the hired developer's in the mock, the one agent's in the app, AP-4903). Where the mock's agent
  is the one agent, the reference's names are changed instead (`renameInReference`: Dusty asking for the deploy and
  Banjo running the review are Neo, the fixture world's name for it, OA-08; Hazel's review is Joris's).

Fixture-world differences are patched in the query cache, not masked (needs-you count, run tick, the approval's
conditions); each spec's header says which. Controls and lines the app adds to a mocked screen are hidden
(`hideAdditions`): the Plans and Open plan buttons, the run's ACTIVITY, the header's bell, More, Pinned and Files,
a message's toolbar and reactions, the thread pane's expand button, an approval's “Always allow” (AP-304, AP-452,
AP-476, AP-680, AP-778).

## CI

`ci/platform/extended.yml` (the maintainers' CI) runs the `visual` comparison (the web app's `visual` Playwright project) as its
`visual` job in the apps' daily qualification, which ci-platform schedules, not on every pull request. Its log and
the Playwright diagnostics (`tmp/playwright/web`) are kept as the run's `visual-log` and `visual-diagnostics`
artifacts.

## `pnpm ref:shot`

```
pnpm ref:shot --file desktop|mobile|avatar [--screen <start>] [--theme light|dark]
              [--width 1440 --height 900 | --size 180] [--prop key=value ...]
              [--click "visible text" ...] [--state key=value ...] [--wait ms] [--wait-for js]
              [--full-page] [--no-freeze] --out <file.png>
```

| option | meaning |
|---|---|
| `--file` | `desktop` (`Whombat Desktop.dc.html`, default), `mobile` (`Whombat Mobile.dc.html`), `avatar` (`WhombatAvatar.dc.html`) |
| `--screen` | desktop `start` prop: `channel`, `branch`, `run`, `search`, `canvas`, `log`, `onboarding` (its DM and roster went with one agent) |
| `--theme` | desktop: the `theme` prop. Mobile renders both phones side by side; `--theme` clips the shot to that phone (and scopes clicks to it) |
| `--prop k=v` | any `data-props` default (repeatable). Avatar props: `role` (architect, developer, researcher, reviewer, operator, support), `dir` (A, B, C), `crop` (bust, head), `silhouette` (true/false) |
| `--click "text"` | click the visible element with that text (buttons first, exact match first), in order (repeatable) |
| `--state k=v` | patch the mock component's state before the clicks (value parsed as JSON, else a string), for states no click reaches: `--state pane=thread` opens the thread pane (the mock's "5 replies" link has no handler). From code: `prepare: (page) => setReferenceState(page, {pane: 'thread'})` |
| `--width/--height` | viewport. Defaults: desktop 1440×900, mobile 1000×1000, avatar 240×240. `--size N` = N×N |
| `--wait ms` | extra settle time after render and after the clicks (default 500) |
| `--wait-for js` | shoot as soon as this page expression is truthy (polled every 50 ms). The desktop mock plays one live tick every 2.6 s: `--wait-for "document.body.innerText.includes('+232')"` captures the run screen at tick 3 (the diff stat is `+214` plus 6 per tick up to tick 6; tick 8 shows `RUN · DONE`) |
| `--full-page` | capture the full scroll height |
| `--out` | output PNG, relative to where you ran the command. Put it under `.visual/` or `tmp/` (both gitignored) |

Examples:

```sh
# Run screen, dark theme, 1440×900
pnpm ref:shot --file desktop --screen run --theme dark --out .visual/ref/run-dark.png

# Channel screen, dark theme
pnpm ref:shot --file desktop --screen channel --theme dark --out .visual/ref/channel-dark.png

# Mobile inbox, dark phone only (390×844)
pnpm ref:shot --file mobile --theme dark --out .visual/ref/mobile-dark.png

# Mobile, both phones
pnpm ref:shot --file mobile --full-page --out .visual/ref/mobile.png

# Developer avatar at 180px, and an operator head crop at 32px
pnpm ref:shot --file avatar --prop role=developer --size 180 --out .visual/ref/avatar-developer-180.png
pnpm ref:shot --file avatar --prop role=operator --prop crop=head --size 32 --out .visual/ref/avatar-operator-32.png
```

## `pnpm visual:diff`

```sh
pnpm visual:diff .visual/ref/run-dark.png .visual/mine/run-dark.png --out .visual/diff/run-dark.png
# → mismatch 0.42% (5443 of 1296000 px) → .visual/diff/run-dark.png
```

Images of different sizes are padded to the larger size (and reported). `--threshold` (0–1, default
0.1) is pixelmatch's per-pixel color tolerance.

## From code

```ts
import { cropPng, diffPng, maskPng, shootReference } from '@whombat/visual-tools';

const ref = await shootReference({ file: 'desktop', props: { start: 'run', theme: 'dark' } });
const { percent } = diffPng(ref, await page.screenshot());

// Compare one region, ignoring deliberate differences (same masks on both sides).
const sidebar = { x: 0, y: 0, width: 256, height: 900 };
const icons = [{ x: 20, y: 134, width: 24, height: 90 }];
diffPng(maskPng(cropPng(ref, sidebar), icons), maskPng(cropPng(mine, sidebar), icons));
```
