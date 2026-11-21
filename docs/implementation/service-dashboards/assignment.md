# Service dashboards — the brief

Spec: `docs/decisions/service-dashboards.md` (SD-01…SD-70, SD-S01…SD-S20). Read it first, then `ARCHITECTURE.md`,
`docs/decisions/connection-pages.md` (CP-*), `dashboards.md` (DS-*), `connections-page.md` (CN-*), `fusebox-page.md`
(FP-*, the newest kind and the best model) and the kinds in `apps/server/src/things/kinds/` (`unifi.ts`, `hetzner.ts`,
`fusebox.ts`, `homeassistant.ts`, `read.ts`, `types.ts`). Lead: session whombat-70.

## Numbers (claimed with peers whombat-05, -a6, -f0, -1b)

- contracts **0.121.0**, CT-1000…CT-1049 (on top of 0.120.0, remote help, already on contracts main)
- whombat-app **0.123.0**, AP-4530…AP-4729 (client AP-4530…4559, web AP-4560…4629, phone AP-4630…4699, spare 4700…4729)
- Whombat migration **0135** (S2: `connection_events`), decisions SD-*, server details SD-S09…SD-S19 for the streams to
  fill in (claim yours in your report; S0 SD-S09/S10, S1 SD-S12/S13, S2 SD-S14/S15, S3 SD-S16, S4 SD-S17, S5 SD-S18,
  W/M AP-*), candidate: what `dev/candidate` gives.

## Repositories, branches, worktrees

Integration branches `sd` (lead only merges into them):
- contracts `~/Code/.wt/contracts-sd` · Whombat `~/Code/.wt/whombat-sd` · whombat-app `~/Code/.wt/app-sd`

Streams (each its own worktree and branch off `sd`; commit there; never push, never merge into `main` or `sd`):

| Stream | Repo | Worktree | Branch | Owns |
|---|---|---|---|---|
| C | contracts | `~/Code/.wt/contracts-sd-c` | `sd-c` | everything in contracts (below) |
| S0 core | Whombat | `~/Code/.wt/whombat-sd-core` | `sd-core` | `things/page.ts`, `things/actions.ts`, `things/routes.ts`, `things/panels.ts`, `things/kinds/types.ts`, `kinds/registry.ts`, `kinds/index.ts`, `kinds/read.ts`, new `things/images.ts`, `things/siblings.ts`, `home/health.ts`, Done recently's filter (`home/changes*`), the session download resource `thing-image`, moving the four first kinds onto the registry (their `*Latest`/`seen` only, not their pages) |
| S1 media | Whombat | `~/Code/.wt/whombat-sd-media` | `sd-media` | `things/kinds/media/**` (Plex, Seerr, SABnzbd, NZBHydra2, Sonarr, Radarr; SD-20…SD-24, SD-10) |
| S2 home | Whombat | `~/Code/.wt/whombat-sd-home` | `sd-home` | `things/kinds/home/**` (HA controls, ESPHome, Protect, Access, Pi-hole, AdGuard; SD-30…SD-34), the Controls insertion in `kinds/homeassistant.ts`, migration 0135 + its schema file + the Protect subscriber's start/stop wiring (SD-S20) |
| S3 infra | Whombat | `~/Code/.wt/whombat-sd-infra` | `sd-infra` | `things/kinds/infra/**` (OPNsense, NPM, Tailscale, Cloudflare, Portainer, Pterodactyl, Grafana; SD-40…SD-46, SD-S11) |
| S4 storage | Whombat | `~/Code/.wt/whombat-sd-storage` | `sd-storage` | `things/kinds/storage/**` (PBS, TrueNAS, Synology, QNAP, Immich, Paperless, Nextcloud; SD-50…SD-57) |
| S5 business | Whombat | `~/Code/.wt/whombat-sd-business` | `sd-business` | `things/kinds/business/**` (Mollie, Moneybird, Plausible, HubSpot, Pipedrive, GitLab, Forgejo, Todoist; SD-60…SD-65) |
| W web | whombat-app | `~/Code/.wt/app-sd-web` | `sd-web` | `packages/client/**`, `packages/brand/**` (Sonarr/Radarr marks), `apps/web/**` |
| M phone | whombat-app | `~/Code/.wt/app-sd-mobile` | `sd-mobile` | `apps/mobile/**` (after W's client part is in `sd`) |

A file outside your column: ask the lead (SendMessage to `main`) instead of changing it. Each group's `index.ts`
already exists and is yours; add your kinds there (`KindModule`, `kinds/registry.ts`). Use `seenFromView` for `seen`.

## The contract (stream C; everything else codes against exactly this)

In `packages/core/src/domain/thing-page.ts` and `contracts/home.ts`, `packages/protocol/src/session/messages.ts`,
the catalog, the fixtures package and the notes (`docs/`), as earlier releases did. Additive only.

```ts
// CT-1000 pictures
export const ThingImageRef = z.string().min(16).max(600).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const ThingImage = z.object({
  ref: ThingImageRef,
  alt: z.string().max(120),
  /** poster 2:3, wide 16:9, square 1:1 — the box the client keeps before the picture arrives. */
  shape: z.enum(['poster', 'wide', 'square']),
});
// endpoint things.image: GET /burrows/:burrow/things/:thing/images/:ref → the picture's bytes (image/jpeg|png|webp),
//   404 for anything wrong; helper thingImagePath(burrow, thing, ref).
// session DownloadResource: { type: 'thing-image', burrow, thing: ThingParam, ref: ThingImageRef }

// CT-1001 buttons
export const THING_BUTTON_ICONS = ['restart', 'power', 'play', 'pause', 'stop', 'check', 'close', 'retry', 'search',
  'lock', 'unlock', 'shield', 'up', 'down', 'open', 'clean', 'speed'] as const;
export const ThingPageButton = z.object({
  action: ThingPageKey,                                   // the kind's action id
  target: z.string().min(1).max(200).optional(),          // a row, entity, request id
  value: z.union([z.string().max(100), z.number(), z.boolean()]).optional(),
  label: z.string().min(1).max(30),
  icon: z.enum(THING_BUTTON_ICONS).optional(),
  tone: z.enum(['primary', 'danger']).optional(),
  confirm: z.object({ title: z.string().min(1).max(80), body: z.string().min(1).max(300),
    button: z.string().min(1).max(30) }).optional(),
  /** False with `reason` for those who may not (Look only, not theirs to manage): drawn disabled with the reason. */
  allowed: z.boolean(),
  reason: z.string().max(200).optional(),
});

// CT-1002 on rows: ThingPageCell.action?: ThingPageButton (a button in the cell; `text` = its label for old clients)
//                  ThingPageItem.image?: ThingImage; ThingPageItem.actions?: ThingPageButton[] (max 3)
// CT-1003 on a panel's head: `buttons?: ThingPageButton[]` (max 4) on table, list, bars, gallery and controls panels

// CT-1004 gallery
export const ThingGalleryItem = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(120),
  sub: z.string().max(120).optional(),          // “2024 · Asked by Anna”
  image: ThingImage.optional(),
  badge: z.object({ text: z.string().min(1).max(30), tone: ThingTone }).optional(),
  progress: z.number().min(0).max(1).optional(),
  note: z.string().max(80).optional(),          // under the progress: “63 % · 12 min left”
  at: Timestamp.optional(),
  muted: z.boolean().optional(),                // an offline camera
  href: HomeHref.optional(),                    // another page of the app
  url: z.string().url().max(500).optional(),    // the service's own page for it
  actions: z.array(ThingPageButton).max(3).optional(),
});
// panel: { kind: 'gallery', ...panel, title, meta, link?, buttons?, shape: 'poster'|'wide'|'square',
//          items: ThingGalleryItem[] (max 48), empty? }

// CT-1005 controls
export const THING_CONTROL_ICONS = ['light', 'switch', 'fan', 'scene', 'script', 'button', 'thermostat', 'blind',
  'lock', 'alarm', 'sensor', 'camera', 'plug', 'door', 'media', 'power'] as const;
export const ThingControl = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(60),
  icon: z.enum(THING_CONTROL_ICONS).optional(),
  state: z.string().max(60).optional(),         // “On · 80 %”, “21.5 °C”, “Locked”
  on: z.boolean().optional(),
  tone: ThingTone.optional(),
  /** A switch: the client sends `value: !on`. */
  toggle: ThingPageButton.optional(),
  buttons: z.array(ThingPageButton).max(4).optional(),
  /** A stepper: the client sends the new `value` (within min…max, by step). */
  stepper: z.object({ value: z.number(), min: z.number(), max: z.number(), step: z.number().positive(),
    unit: z.string().max(8).optional(), button: ThingPageButton }).optional(),
  image: ThingImage.optional(),
});
// panel: { kind: 'controls', ...panel, title, meta, hint?: string(≤200), buttons?,
//          groups: { id, title (≤60), items: ThingControl[] (max 48) }[] (max 16), empty? }

// CT-1006 things.action body { action, target?: string(1..200), value?: string(≤100)|number|boolean };
//         response { message, changeId?, refresh?: boolean }  (the client reads the page again at once)
// CT-1007 THING_NOTICE_ICONS += 'download', 'camera', 'door', 'media', 'money', 'shield', 'certificate'
// CT-1008 a Change kind `thing.control.*` (everyday switches, SD-08) wherever Change kinds are listed, if they are
// CT-1009 catalog: `sonarr`, `radarr` entries (SD-S07); `overseerr` shown as name 'Seerr' (id unchanged, description
//         and docsUrl https://docs.seerr.dev/), help words naming Seerr first
// CT-1010 ThingPage.refreshS documented as “a live page asks again this often while open” (min 5, unchanged)
// CT-1011 fixtures: thing pages for Plex, Seerr, SABnzbd, Home Assistant with Controls, UniFi Protect and Pi-hole in
//         @whombat/fixtures, wherever the web's and phone's fixture mode reads thing pages (W and M check visually)
```

C: tests for every new schema (accepts the examples above, refuses out-of-range), the notes for 0.121.0, `pnpm check`,
then **a provisional `dist-release/0.121.0`** (`pnpm release` as earlier provisional builds; don't tag) and tell the lead
where it is. The lead vendors it into `sd` (Whombat and app) and tells every stream to `git merge sd`.

## Server rules (S0…S5)

- **Kinds**: one file per service (two that share a shape share one: `dns.ts` for Pi-hole + AdGuard, `arr.ts` for
  Sonarr + Radarr, `crm.ts`, `git.ts`), a `<name>.test.ts` beside it. Model: `fusebox.ts` + `fusebox-pool.ts` — a
  snapshot reader (`latestRead`/`cachedRead` from `read.ts`, one read per page build, SD-S05), pure functions from
  snapshot to figures/panels/notices (unit-tested with fixtures), the `KindPage` that puts them together, `seen` via
  `seenFromView`, and `actions`.
- **Words**: as every page today (`things/words.ts`: `plural`, `thousands`, `bytes`, `span`, `clip`, `dayMonth`…):
  short, plain, curly quotes ’ “ ”, `·` between parts, figures formatted by the server. Concise-replies applies to
  every line a person reads. Names of people only for managers (SD-04: `ctx.canManage`).
- **Reads**: only GETs (and the WebSocket/JSON-RPC reads some services need) for the page; writes only in `actions`.
  Never read secrets (settings endpoints that return passwords/keys). Keep to the endpoint list verified in the
  research (in the decisions' rows and below); when an endpoint answers 404/405 on an older version, leave that part out.
- **Check the real API where it is cheap**: start the service in a throwaway container and save trimmed real answers as
  test fixtures (no keys, no personal data). Read `/home/me/Code/dashboard/docs/agent-resources.md` first; use
  `agent-resource run --task "<stream>: <service> fixtures" --ttl 2h -- <your script>` (inside it
  `agent-resource docker-run …`) or a lease you release at the end, then `agent-resource check <id>`. Never raw
  `docker run`. Worth it: SABnzbd, NZBHydra2, Sonarr, Radarr, Seerr (S1; Plex only if an unclaimed server answers
  locally); Pi-hole v6, AdGuard Home, ESPHome Device Builder, Home Assistant (S2); Nginx Proxy Manager, Portainer,
  Grafana (S3); Paperless-ngx, Nextcloud (S4); Forgejo (S5). The rest from their documented answers.
- **Tests**: unit tests with fixtures (`vitest`), no assertions on long literal text (check figures, ids, tones, which
  buttons exist with which action/target/allowed), no sleeps. Postgres integration tests only where they need the
  database: S0 (image route + action commit + Done recently filter, one file), S2 (connection_events keep/prune).
- **Checks**: `pnpm install --frozen-lockfile` once in your worktree, then during work `pnpm vitest run <your files>`
  and `pnpm --filter @whombat/server typecheck`; at the end `pnpm format` and one full check, serialised with the other
  streams: `flock ~/.cache/wb-tmp/sd-check.lock pnpm check`. `pnpm test:server` only S0 and S2, once, at the end.
  Environment: `export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH; export
  TMPDIR=/home/me/.cache/wb-tmp`. Postgres for int tests: the shared one on :55432, the harness makes its own
  throwaway databases; never touch shared containers.
- **Before the contract arrives** (first ~45 min): write the snapshot readers, fixtures and pure functions, the parts of
  the page that use today's panels (kpis, notices, table, list, bars, facts, chart). When the lead says “merge sd”,
  `git merge sd`, `pnpm install --frozen-lockfile`, then add galleries, controls, buttons and pictures.
- **Pictures** (S0 gives `imageRef(ctx, { path, source?: 'c'|'t', snapshot?: boolean }) → ThingImage['ref']` in
  `things/images.ts`; until it is in `sd`, leave the picture out and keep a `// SD: picture` note where it goes).
- **Sibling links** (S0 gives `siblingThing(ctx, ['sabnzbd'])` in `things/siblings.ts`, same arrangement).

## S0 core — also

- Move `page.ts` and `home/health.ts` onto `KIND_MODULES` (SD-S01) without changing what the four first kinds show;
  keep Fusebox's specifics (PREFETCH's time zone, gateway head facts and access panel, `watched`, its `seen`).
- SD-S02 (`machine: 'after'`, `charts` defined = no response chart, `refreshS`), SD-S03 (images: route, session
  resource, signing, fetch, cache, downscale with the preview worker; TMDB through the link-preview fetcher), SD-S04
  (actions: body `{action,target,value}`, registry dispatch, central checks, everyday changes out of Done recently,
  Home Assistant's Restart moves onto the registry), SD-S08 (`siblingThing`), `liveS` cache in `read.ts` (SD-S05).
- Merge into `sd` early: the lead merges a first S0 commit with `images.ts`/`siblings.ts`/registry wiring as soon as it
  typechecks, so S1…S5 can use them.

## W web and M phone

- W: draw `gallery` (posters 2:3 in rows, wide snapshots 16:9, square thumbnails; progress bar + note under; badge;
  muted; actions as small buttons under the title), `controls` (groups as sections; tiles with icon, label, state; a
  switch for `toggle`; buttons; a −/+ stepper; image tile), panel head `buttons`, cell `action` buttons, item `image`
  and `actions`; every button: disabled with `reason` as its tooltip when `allowed` is false, a confirm dialog when it
  has `confirm`, `things.action` with `{action,target,value}`, the toast with `message`, then read the page again;
  honour `refreshS` while the page is open and visible; pictures through `things.image` (as attachment images are
  loaded: HTTP on the web, the session's `thing-image` stream where the client talks through a session), with the
  shape's box while loading and nothing broken when one fails. Marks for Sonarr and Radarr (Simple Icons) in
  `packages/brand`. Tokens only, both themes, the existing Card/Table/button components; check in fixture mode at
  1440×900, light and dark, and on a narrow width. Decisions in app `docs/decisions/service-dashboards.md` (AP-4530…).
- M: the same panels on the phone (stacked; gallery as a horizontal row of posters or a two-column grid of snapshots;
  controls as tiles two per row, 44 px targets; confirm as a sheet), pictures through the client's image loading,
  `refreshS` while the screen is focused. AP-4630…4699.
- App checks: `pnpm check` in whombat-app, one repository's check at a time (`flock ~/.cache/wb-tmp/sd-app-check.lock`).

## Commits and reports

- Small focused commits, imperative (`server: Plex page (SD-20)`), each ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Record your own new decisions as SD-S rows (server) or
  AP rows (app) in the decisions file of your repo.
- No waiting for future data, no sleep loops, no VM tests. When blocked, say so to the lead at once.
- Report at the end (to the lead): branch + last commit, what is done per service, which fixtures came from a real
  service, check results with counts, anything left out and why, ids used.
