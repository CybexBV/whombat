# Quiet notices — the brief

Spec: `docs/decisions/quiet-notices.md` (QN-01…QN-24). Read it first, then the catalogue files beside this brief
(`catalogue-home.md`, `catalogue-infra-media.md`, `catalogue-storage-business.md`, `catalogue-cross-cutting.md`: one row
per notice Whombat makes today with its proposed check, subject, nature, Ignore words, how it lifts and noise notes;
they are proposals: decide where they disagree with the spec, the spec wins), `ARCHITECTURE.md`, `CLAUDE.md`, and
`apps/server/src/things/quiet/types.ts` (the shared types every stream codes against). Lead: session whombat-4f.

## Numbers (claimed)

- contracts **0.122.0**, CT-1060…CT-1099 (on top of 0.121.1)
- whombat-app **0.124.0**, AP-4800…AP-4899 (client AP-4800…4819, web AP-4820…4859, phone AP-4860…4899)
- Whombat migration **0136**, decisions QN-*, server details QN-S01… (S0 QN-S01…S19, S1 QN-S20…29, S2 QN-S30…39,
  S3 QN-S40…49, S4 QN-S50…59), appended to `docs/decisions/quiet-notices.md` under “Server details” in your branch
- appliance console CG-330…CG-349 · hosts HS-190…HS-209

## Repositories, branches, worktrees

Integration branches `qn` (the lead only merges into them): contracts `~/Code/.wt/contracts-qn` · Whombat
`~/Code/.wt/whombat-qn` · whombat-app `~/Code/.wt/app-qn` · appliance `~/Code/.wt/appliance-qn` · hosts
`~/Code/.wt/hosts-qn`.

Streams: each its own worktree and branch off `qn` (`git -C <repo> worktree add -b qn-<x> ~/Code/.wt/<repo>-qn-<x> qn`);
commit there in small commits (`server: …`, imperative, ending with the Co-Authored-By line of CLAUDE.md); never push,
never merge into `main` or `qn`. When the lead says “merge qn”, `git merge qn` into your branch.

| Stream | Repo | Owns |
|---|---|---|
| C | contracts | everything in contracts (below) |
| S0 core | Whombat | `things/quiet/**` (new), migration 0136 + its schema file, `things/page.ts`, `things/panels.ts` (generic notices), `things/machine.ts` (disk notice), `things/devices.ts`, `devices/home.ts`, `things/kinds/types.ts`, `kinds/registry.ts`, `kinds/first.ts` (the glance wiring only), `things/routes.ts`, `home/health.ts`, `home/overview.ts`, `home/snoozes.ts`, `home/mail-glance.ts`, `connections/notify.ts`, `desk/glance.ts` + `desk/service.ts` + `desk/socket.ts` (looks and their quiet), the assistant's reads of things |
| S1 home | Whombat | `kinds/unifi.ts`, `kinds/home/**`, `kinds/homeassistant*.ts`, `kinds/ha-socket.ts`, `kinds/hetzner.ts`, `kinds/fusebox*.ts`, `kinds/unraid.ts` |
| S2 infra+media | Whombat | `kinds/infra/**`, `kinds/media/**` |
| S3 storage+business | Whombat | `kinds/storage/**`, `kinds/business/**` |
| H hosts | the hosts service | the hub (below) |
| S4 servers | Whombat | `apps/server/src/hosts/**` (after H's API and S0's store exist) |
| W web | whombat-app | `packages/client/**`, `apps/web/**` |
| M phone | whombat-app | `apps/mobile/**` (after W's client part is in `qn`) |
| D desk | appliance | `console/**` (the desk screen and its Go API) |

A file outside your column: ask the lead (SendMessage to `main`) instead of changing it.

## The contract (stream C; everything else codes against exactly this)

Additive only. `packages/core/src/domain/quiet.ts` (new, exported from the index), `domain/thing-page.ts`,
`domain/home.ts`, `contracts/home.ts`, `domain/desk.ts` (words), `control-contracts/src/local/desk.ts`, hosts domain,
the protocol's session ops, fixtures, `pnpm gen` (schema, vectors, Go), the notes in `docs/decisions/contracts.md`.

```ts
// CT-1060 kinds of line, checks, Ignore
export const NOTICE_NATURES = ['problem', 'you', 'fyi'] as const;          // Problem · Only you · Heads-up
export const NoticeNature = z.enum(NOTICE_NATURES);
export const QUIET_LIFTS = ['fixed', 'newer', 'period'] as const;
export const NoticeCheck = z.string().max(80).regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
export const NoticeSubjectId = z.string().min(1).max(160);
export const NoticeSubject = z.object({ id: NoticeSubjectId, name: z.string().min(1).max(80) });
export const NoticeRef = z.object({ check: NoticeCheck, subject: NoticeSubjectId.optional() });
export const NoticeIgnore = z.object({            // what Ignore would do; present only for who may quiet it
  lifts: z.enum(QUIET_LIFTS),
  words: z.string().min(1).max(60),              // “Until it’s back online.”
  until: Timestamp.optional(),                   // period: when it resets
});
export const NoticeQuiet = z.object({             // the line is quiet: drawn greyed at the bottom
  state: z.enum(['ignored', 'snoozed']),
  words: z.string().min(1).max(60),              // “until it’s back online”, “until tomorrow 09:00” (lower case)
  until: Timestamp.optional(),
  by: z.object({ id: PrincipalId, name: z.string().min(1).max(80) }).optional(),
  at: Timestamp,
});
export function noticeNature(n: { nature?: NoticeNature; tone: 'bad'|'warn'|'info'; link?: { kind: string } }): NoticeNature
  // n.nature ?? (tone info → fyi; link ask → problem; else you)
export const QUIET_WORDS = {
  menu: 'More for {title}',            // the ⋯ button's label
  ignore: 'Ignore', snooze: 'Remind me tomorrow', stop: 'Stop watching {name}', stopThis: 'Stop watching this',
  ignored: 'Ignored by {name} {words}', snoozed: 'Snoozed by {name} {words}', ignoredBare: 'Ignored {words}',
  undo: 'Undo', toastIgnored: 'Ignored. You’ll hear if it changes.', toastSnoozed: 'I’ll remind you tomorrow.',
  toastStopped: 'Whombat stopped watching {name}.', toastWatched: 'Whombat watches {name} again.',
  watchTitle: 'What Whombat watches', watchNot: 'Not for:', always: 'always', watchEmpty: 'Nothing to watch here yet.',
  natures: { problem: 'Problem', you: 'Only you', fyi: 'Heads-up' },
} as const;

// CT-1061 on the line (all optional: an older server sends none, an older client ignores them)
ThingPageNotice += { nature?: NoticeNature, check?: NoticeCheck, subject?: NoticeSubject,
                     ignore?: NoticeIgnore, quiet?: NoticeQuiet }

// CT-1062 What Whombat watches
export const ThingWatchException = z.object({
  subject: NoticeSubject.optional(),             // absent: the check as a whole is ignored/snoozed
  state: z.enum(['stopped', 'ignored', 'snoozed']),
  words: z.string().max(60).optional(),          // “until it’s back”, “always”
  until: Timestamp.optional(),
  by: z.object({ id: PrincipalId, name: z.string().min(1).max(80) }).optional(),
  at: Timestamp,
});
export const ThingWatchCheck = z.object({
  check: NoticeCheck, name: z.string().min(1).max(80), nature: NoticeNature,
  on: z.boolean(), perItem: z.boolean(),
  off: z.object({ by: …optional, at: Timestamp }).optional(),   // who switched it off
  exceptions: z.array(ThingWatchException).max(100),
});
export const ThingWatch = z.object({ checks: z.array(ThingWatchCheck).max(120), mayChange: z.boolean() });

// CT-1063 ops (contracts/home.ts thingEndpoints; session ops as for things.page/action)
things.quiet    POST /burrows/:burrow/things/:thing/quiet
  body QuietNoticeBody { notice: NoticeRef, how: 'ignore' | 'snooze' | 'undo', until?: Timestamp }
       // snooze without until: 09:00 tomorrow in the burrow's zone; undo: takes back an ignore or a snooze
  → { notice: NoticeRef, quiet: NoticeQuiet | null }      403 not_allowed, 404 not_found (no such line now; undo: none)
things.watch    GET  /burrows/:burrow/things/:thing/watch  → ThingWatch
things.setWatch POST /burrows/:burrow/things/:thing/watch
  body { check: NoticeCheck, subject?: NoticeSubject, watched: boolean } → ThingWatch   403 not_allowed, 404 not_found
// :thing is the thing id (`connection:…`, `server:…`, `device:…`) as for things.page.

// CT-1064 Home: NeedsYouItem.nature?, WatchItem.nature?; needsYou.ignore's note: on `alert` and `connection` items it
//   is the shared Ignore (quiet-notices.md QN-21), else the person's own as before.
// ConnectionGlance is server-only; ThingSummary gains nothing.

// CT-1065 Desk (control-contracts local/desk.ts)
DeskLook += { notice?: { check: NoticeCheck, subject?: NoticeSubjectId },
              nature?: NoticeNature,                     // absent: problem (0.118 behaviour)
              ignoreWords?: text(60),                    // “Until it’s back online.”
              question?: text(300) }                     // the line's own question for Ask
POST /v1/desk/look/quiet  DeskLookQuietRequest {v, key, notice: {check, subject?}, how: 'ignore'|'snooze'}
  → DeskAck {v}; 409 locked, 403 not_allowed, 404 not_found
DESK_WORDS.looks: fix → 'Ask {assistant} to look into it'; + ignore: 'Ignore', notNow: 'Not now',
  ignored: 'Ignored. You’ll hear if it changes.', snoozed: 'I’ll remind you tomorrow.'
// a heads-up is never a look (the runtime leaves it out).

// CT-1066 Servers (hosts domain)
HostAlert += { entity?: string (≤200, the disk, guest, check it is about), key?: string (rule:entity) }
HostHint  += { id?: string (≤200, kind:entity) }
export const HOST_WATCH_CHECKS: readonly { check: NoticeCheck /* host.<rule> or host.hint.<kind> */, rule?: string,
  hint?: string, name: string, nature: NoticeNature, lifts: QuietLifts, words: string, perItem: boolean }[]
  // one entry per hub alert rule and hint kind (catalogue-cross-cutting.md C.3, C.4); the client builds a server
  // page's notices from it, the runtime its What Whombat watches.
```

## Server core (S0)

**Store, migration 0136** (`apps/server/src/db/schema/quiet.ts`, `db/migrations/0136_quiet_notices.sql`, compat):
- `notice_quiets`: owner (the burrow for shared things, the account for personal connections), `thing_id`, `check_id`,
  `subject` (`''` = the whole thing), `state` ignored|snoozed, `lifts`, `episode`, `tone`, `band`, `until`,
  `clear_passes`, `title`, `subject_name`, `by_id`, `at`; PK (owner, thing, check, subject).
- `watch_offs`: owner, thing, check, subject (`''` = the whole check), `subject_name`, `by_id`, `at`.
- `notice_states` (operational, written by the health pass like the glance): thing, check, subject, `first_seen`,
  `last_seen`, `seen_passes`, `tone`. Used for `confirm` (two passes) and “since”.
Writes by people go through the commit pipeline as commands with events (look at `home/snoozes.ts`), recorded in the
thing's Activity as everyday changes (QN-17). The health pass's lifts and states are operational (as `glance`).

**One pure function** (`things/quiet/apply.ts`, unit-tested hard): given a thing's lines, its quiet rows, its offs, its
states, `now`, the checks skipped and whether this is a health pass, it returns the active lines, the quiet lines (with
`quiet`), the lines not watched (dropped), the status (worst tone among active lines whose nature isn't `fyi` and that
are confirmed), the reason and badge (that line's `badge` words or title), the rows to lift (QN-11, QN-12) and the
states to write. Lifting happens only in a health pass; a page read only marks. Grouped lines: the kind's episode.

**Hooks** (catalogue-cross-cutting.md §E has the file:line list): the page (Worth a look: active by tone, then heads-ups,
then quiet ones greyed; the head's status and badge from the active lines; `ignore` only for who may manage; strip the
server-only parts), the health pass (every kind's `seen.notices` → apply → glance `status`, `reason`, plus
`notice?: {check, subject?, nature, ignoreWords?, question?}` of the worst active line for the desk; the four first kinds
too, through `kinds/first.ts`; the check's own failure paths become lines `conn.answers` (problem), `conn.signin` (you)
so they can be ignored too), Home's cards and Watch and Needs you (QN-21, QN-22: `needsYou.ignore` on `alert` and
`connection` refs becomes the shared quiet; for `alert` refs S4 sends it to the hub), devices and mail glances, the desk's
looks (nature, notice, ignore words, question; fyi never; quiet never) and `POST /v1/desk/look/quiet` (unlocked, the
paired person may manage the thing), `things.quiet`, `things.watch`, `things.setWatch` (connections and devices here;
servers are S4's: route `server:` things to a function S4 fills, stubbed until then), and the assistant's reads of thing
status (mark quiet lines, QN-24). Generic lines (`panels.ts`), the machine's disk (`machine.ts`: bands 75/90; a forecast
further than 7 days is a heads-up), devices: checks, natures, words. `KindModule.checks` + the generic checks make What
Whombat watches. After every kind fills `NoticeWatch`, narrow `KindView.notices` to `KindNotice[]` (the lead tells you).

## The kinds (S1, S2, S3)

For every notice in your files, following your catalogue file (decide where it is unsure; the spec wins):
1. Fill `NoticeWatch`: `nature`, `check` (`<kind>.<what>`), `subject` for per-item lines (split grouped lines into one
   line per item, at most 8, then one “and N more” line with `episode` = a short hash of the rest's ids), `ignore`
   (`lifts`, `words` as a sentence, `until` for period), `episode`, `band`, `confirm: 2` for flapping checks.
2. Only problems keep an `ask` link; only-you lines get a link or button to where it's done; heads-ups keep a link only
   when it shows more (“Who used it”), never an ask.
3. `seen` returns `notices` (the same lines the page shows, built from the same read) and `skipped` (checks whose part
   wasn't read or was capped). A kind's own status function (`fuseboxStatus`, `unifiGlanceOf`, `statusFrom`, `cardOf`,
   `statusOf`, the infra head badges) no longer decides the dot: every warn/bad state is a line; keep only the ok badge
   words (`KindView.status` when ok) and give the worst line a `badge` text when the title is too long for the head.
4. `KindModule.checks`: every check the kind can raise.
5. The noise notes of your catalogue (QN-04): implement the ones marked as fixes (two passes, heads-ups for things done
   on purpose, schedule-aware late backups, averaged CPU, duplicates, thresholds).
6. Unit tests per kind (lines, natures, keys, episodes, the noise rules); keep the existing tests green.

## Hosts (H) and servers (S4)

H (the hosts service, Go; read `CLAUDE.md`/`AGENTS.md` there; HS-190…): the server's `status`/`status_note` come only from
alerts that ask for attention (not acknowledged, muted or suppressed); alerts carry `entity` and `key` in the JSON; a
severity rising within one rule ends its acknowledgement; per-server watch settings: `GET /api/v1/servers/{id}/watch`
→ `{rules: [{rule, entity?, off: true, by, at}]}`, `PUT` the same with `{rule, entity?, off}` (operator; audit-logged;
an off rule isn't evaluated for that server/entity and an open alert of it resolves); hints carry a stable `id`
(`kind:entity`). Docs (`docs/REST-API.md`, `docs/WHOMBAT.md`), tests, `make check` or the repo's own check.

S4 (Whombat `hosts/**`, after H and S0): the hosts client for watch settings and acknowledge; `things.quiet` /
`things.watch` / `things.setWatch` for `server:` things (alerts → the hub's acknowledge until resolved, snooze until
09:00, undo; rules → the hub's watch settings; hints → S0's quiet store and offs); `needsYou.ignore` on alerts; server
cards, reasons, Watch, desk looks follow attention only and leave out quiet hints; the assistant's host tools mark quiet.

## Apps (W, M) and desk (D)

W (whombat-app `packages/client`, `apps/web`; after C's provisional dist is vendored): the ⋯ menu on every line with
`ignore` (Ignore + its words, Remind me tomorrow, Stop watching {subject.name} / this), quiet lines greyed at the bottom
with “Ignored by John until it’s back online” and Undo, toasts (QUIET_WORDS), What Whombat watches on every thing's
Settings tab (switches, exceptions with Undo), Needs you's toast for alert/connection items, the server page's lines
built in `hosts/dashboard.ts` from `HOST_WATCH_CHECKS` (attention only; acknowledged ones as quiet lines), nature-aware
links. Reuse `ContextMenu`/`MenuButton`. Visual check against the mocks in both themes at 1440×900.
M (Android, after W's client): the same on the phone (⋯ opens a sheet; long press on a line too), 44 px targets.
D (appliance `console/**`; read the appliance `CLAUDE.md`): the look card's buttons by nature (QN-20), the new request
through the console's Go API to the runtime's `/v1/desk/look/quiet`, PIN first when locked, the toasts, DESK_WORDS from
the vendored contracts; console tests.

## Finishing a stream

`pnpm format` then your repo's check (Whombat: `TMPDIR=~/.cache/wb-tmp pnpm check`; S0/S4 also `pnpm test:server`
against your own throwaway database: see CLAUDE.md, never the shared ones), all green; commit; report to the lead in
at most 300 words: commits, what's done, what's left, decisions you added (QN-S…), anything another stream must know.
