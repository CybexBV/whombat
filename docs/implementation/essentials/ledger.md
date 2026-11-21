# Ledger — essentials (2026-09-30)

Spec: `assignment.md`. Items 1–12 and 14 of the product review (item 13 excluded).

| Stream | Scope | Worktree | State |
|---|---|---|---|
| C | contracts 0.26.0 | `~/Code/.wt/contracts-essentials` | DONE — contracts main ba3b2b9, tag contracts-v0.26.0 pushed (CT-166…CT-184); vendored: Whombat 0dae72a8, app 97d06fc |
| R1 | runtime: 1, 2, 3, 4, 6, 7 | `~/Code/.wt/whombat-es-agents` | DONE — merged into Whombat main 4975de14 (EA-01…EA-11, migration 0052_essentials_agents); check 1364, test:server 1239 |
| R2 | runtime: 8, 9, 11, 14, 5 | `~/Code/.wt/whombat-es-conversations` | DONE — merged into Whombat main ede30f69 (EC-01…EC-30, migration 0054_conversations); all runtime features implemented |
| R3 | runtime: 10, 12 | `~/Code/.wt/whombat-es-people` | DONE — merged into Whombat main 674c7a3e (EP-01…EP-19); migration renamed 0053_people_notify (848db5d7) |
| W1 | web: 8, 14, threads | `~/Code/.wt/app-es-messages` | DONE — merged into app main 3ab1bdd (AP-440…AP-455) |
| W2 | web: 9, 11, 12 bell, presence | `~/Code/.wt/app-es-conversations` | DONE — merged into app main a70b0aa (AP-460…AP-479); app-v0.16.1 |
| W3 | web: 4, 5, 6, 10, 12 settings | `~/Code/.wt/app-es-settings` | DONE — merged into app main b1895a3 (AP-480…AP-499); check 1706 |
| M | mobile | `~/Code/.wt/app-es-mobile` | DONE — merged into app main 569a7df (AP-500…AP-519), on top of whombat-84's 0.17.0; app repo only, no candidate |

## Lead notes
- 2026-09-30 13:10: contracts 0.26.0 released (fast-forward of `essentials`, tag at ba3b2b9). Vendoring needed small
  compile fixes: placeholder trigger lines (persona, work-overview), notify titles and managed push kinds for `direct` and
  `reply`, the new runtime features listed in `NOT_IMPLEMENTED` (each stream moves its own), app FEATURE_NAMES copy, a
  `conversation.notify` reducer, inbox counts, mobile route for `direct`, web/mobile `retry_turn` placeholders. A
  level-21 runtime is now below the client's API window (CT-183); DEV and PROD are at 23.
- Exact shapes for the streams: `contracts-0.26.md`.
- Mobile (M) starts when a slot frees (concurrency).
- R1 merged (4975de14). Told R2 and R3 to merge main; R3 also handles retired agents in R1's retry and wake paths.
- Codex latest-tested job rerun with `--retry-failed --only codex` (it clones Whombat main, which has EA-01);
  log `~/.cache/wb-tmp/es-codex-latest-tested.log`.
- Item 7 live on DEV: the Codex job passed 0.159.2 and published client channel 4 (claude 2.1.283–285, codex 0.157.1 +
  0.159.2; expires 2026-10-07) to updates-dev.whombat.com.
- R3 merged (674c7a3e); its migration renamed from 0054 to 0053 (journal position) in 848db5d7; R2 takes 0054.
  R2 told: `notifyForMessage` after edits, `presenceFor(...).activeAmong`, openDirect refuses removed people, digest
  skips deleted messages. W2/W3 told: pickers filter `isActivePrincipal`; settings tab name `notifications`.
- Note for DEV: the first email-digest run after deploy mails what stayed unread in the last 24 h (self-hosted with SMTP
  only; the managed dev instance has no mail).
- Runtime main after R1+R3: unit 1390, test:server 1274, pushed (848db5d7).
- W3 merged into app main (b1895a3, pushed); W1 asked to merge main and resolve (MessageRow); W2 and M told.
- Two e2e:managed tests fail on unmodified main 97d06fc too (“team agent: runs on an organization key…”, “skew: a
  Whombat below…”): pre-existing, not from this work; check whether the skew one is CT-183's new window.
- R2 merged (ede30f69): journal 0052 agents, 0053 people, 0054 conversations; `NOT_IMPLEMENTED` empty. Unit 1421 on main.
- Integration run (runtime main ede30f69 on DB `whombat_es_e2e`, :24410; app main 3ab1bdd via Vite :25180; seeded
  mock world, signed in as Mara): edit + “(edited)”, pin + “Pinned · 1”, emoji picker reaction, reply in thread on a
  message without replies, delete a root with a reply → tombstone (text cleared, reply kept, pin cleared),
  Settings → Notifications with DND 1 h, Members role change + remove Tom, retire Sketch (roster 6→5), search filters,
  New canvas, `/pr/482?repo=whombat%2Fbilling` all work. Found: sidebar still lists the retired agent → sent to W2.
  Screenshots `~/.cache/wb-tmp/audit/e2e/`.
- Another session (whombat-84, John's direct ask) is renaming Settings → Software Dev to “Repositories” and adding repos.create:
  it takes contracts 0.27.0, migration 0055, app 0.17.0 and the candidate after 0.23.0. Told it to avoid sidebar/router/
  apps/mobile until W2 and M land; I message it when app 0.16.0 is tagged and 0.23.0 is on DEV.
- **DEV live on candidate 0.23.0 (2026-09-30 12:25 UTC, IN-134):** app-v0.16.0 (867d511; contracts 0.26.0, API level 24),
  Whombat main 6a8badcd (vendors app 0.16.0), appliance 4f4d596. Runtime migrated 0052–0054 in place; all 14 services
  running; control still on contracts 0.25.0 (unchanged pin, fine). John: “no CI flows … online on dev asap” — no
  validation run. Nix pnpm store hash not refreshed (needed before a box build). Env backup
  `~/.config/whombat/stack-dev.env.bak-pre-0.23.0`.
- Next: W2 → app 0.16.1 → Whombat vendoring → candidate 0.23.1 → dev restart; then M (mobile only, no dev impact).
- **DEV live on candidate 0.23.1 (12:33 UTC):** app-v0.16.1 (19fb414; W2), Whombat f029db95 (vendors it), appliance 4f9cdcf
  (flake.lock moved to f029db95; pnpm hash refresh running: `~/.cache/wb-tmp/es-nix-hash2.log`).
- Other sessions: contracts 0.26.1 (whombat-85: phone QR sign-in, CT-190/191) and 0.27.0 (whombat-84: repos.create,
  CT-192) exist on top of 0.26.0; whombat-85 takes app 0.16.2 / candidate 0.23.2 (IN-135) after my mobile branch lands,
  whombat-84 app 0.17.0 / candidate 0.24.0.
- Mobile merged (569a7df) after whombat-84 shipped app 0.17.0 / candidate 0.24.0 (IN-136) on top of my 0.23.1. whombat-85 next
  (0.24.1). The appliance's pnpm store hash for f029db95 refreshed and pushed (38cb403).
- Worktrees and branches removed; throwaway runtime, web server and DB `whombat_es_e2e` gone.
- **Open follow-ups** (from the streams' reports): fixture-world data for the essentials on mobile + an emulator pass
  (AP-519); scroll-to-message from a pinned message on the phone; Android app links for `/direct/` and `/pr/`; email /
  thread-reply preferences web-only on the phone; the web header is two lines beside a pane in `#billing-v2`; the edit box
  has no `@` picker; seeded/legacy PR links carry no `repo` (the chooser covers it); self-hosted turns over 135 minutes
  still lose their token (no wall time of their own); first email digest after deploy mails what stayed unread in the
  last 24 h; the approvals' seeded deploy #12 fails honestly on a Whombat without a deploy workflow. No validation was
  run for 0.23.0/0.23.1 (John: DEV fast); before production: `release/ship all <id> --validate`.
