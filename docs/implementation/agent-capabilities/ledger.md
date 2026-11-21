# Agent capabilities — ledger

Newest last. What was done, where, and what is next, so the work survives context limits.
Assignment: `assignment.md` (this folder). Plan: `plan.md`. Evidence: `verification.md`.

- 2026-09-28 10:00 Worktrees `~/Code/.wt/{whombat,whombat-contracts,whombat-app,whombat-appliance}-capabilities`,
  branch `capabilities` each, from contracts 5ccff71 (0.19.0), Whombat 3715498 (contracts 0.18.0, app 0.9.1 vendored),
  whombat-app e9f18c6 (0.10.1, AP-194 used), appliance 9b82d4f (IN-86, NX-92 used; candidate 0.17.1 latest).
  Numbering therefore: CT-119+, AP-195+, IN-87+, NX-93+ (NX-90…92 were taken by iso-generic meanwhile).
- 10:40 Decisions written and committed (6c8cbfa): `browser.md` BT-01…11 + BT-D01…04, `skills-library.md` SL-01…12 +
  SL-D01…04, `agent-roles.md` AR-01…08 + AR-D01…02, `spend.md` SP-01…03 + SP-D01…02, `vault.md` VT-D28…VT-D33 (the
  `login` kind; the old basic-auth template becomes `basic` “Basic auth”, the new one is “Login”).
- 10:50 Contracts foundation on `capabilities` 01fe9f1 (keys `browser.use` → implies `web.browse`, `workspace.scratch`,
  `skills.propose`; six roles + copy + `ROLE_GUIDANCE` + `CAPABILITY_ROLES`; role default keys; `hireKeyOptions(role)`;
  personal agents may hold `skills.propose` and `workspace.scratch`). 546 core tests pass.
- 11:00 Agents running: `avatars` (whombat-app `capabilities-avatars`, checkpoint screenshots to
  `~/.cache/wb-tmp/cap-shots/avatars/`), `contracts-a` (`capabilities-a`: manifest roles/requires, scanner, proposals,
  skill switches, SkillHint, scratch, guides topic; CT-119…124), `contracts-b` (`capabilities-b`: Vault login, browser
  rule + tools, activity copy, DispatchContext.browser, HostInfo.browser, spend; CT-125…129), `packs` (Whombat
  `capabilities-packs`: eleven shipped packs), `rt-browser` phase 1 (Whombat `capabilities-browser`: host process,
  proxy, client, supervisor, install, packaging), `appliance` phase 1 (unit, uid, cgroup, memory gate, wall,
  toolchain libraries; NX-93…, IN-87…).
- 11:35 Migration `0048_capabilities` committed on Whombat `capabilities` (cf0ccde): pack_skills_off, skill_proposals,
  skill_uses, messages.skill_hint, pack_versions.scan/created_by, packs.owner_agent_id,
  principals.role_packs_dismissed_at, vault_entries.totp_sealed, dispatches_finished_idx; compat floors 0048.
- 11:50 Avatars done (whombat-app `capabilities-avatars` 342d338…ab5a8d9, AP-195…AP-199; 1190 tests). Merged into app
  `capabilities` (3822916) for further work; main waits for John's answer on the checkpoint (screenshots sent).
- 12:05 Contracts B done (`capabilities-b` a1b4907…562e9ab, CT-125…CT-129; 884 tests; `gen:check` clean).
- 12:10 Appliance phase 1 done (`capabilities` fb4b4dc…260ae12; NX-93…NX-98, IN-87): unit runs
  `${runtime profile}/bin/whombat-browser-host` (bundle wraps `app/browser-host.mjs`), uid 961, slice MemoryMax
  1536M, memory gate (10 % margin), wall for the uid (public 80/443, Vault networks, no UDP, own loopback only), kiosk
  policies hidden from the unit, toolchain + python-docx/openpyxl/python-pptx/pypdf/Pillow (+97 MiB toolchain, +49 MiB
  toplevel), `vm-tests/browser.nix` 10/10 against the stand-in. Asked rt-browser for `chromiumSandbox: true`
  (`WHOMBAT_BROWSER_SANDBOX`), socket chmod, system resolver, surviving renderer kills.
- 12:40 Contracts A done (`capabilities-a` 42bc0a1…53b87f3, CT-119…CT-124, 1021 tests). Merged A + B into contracts
  `capabilities`, bumped to 0.20.0 (CT-130, b2b45bf), `pnpm check` green, **tagged `contracts-v0.20.0` and released**
  (`dist-release/0.20.0`, reproducible, smoke 33 subpaths; copied to the main checkout's `dist-release/`).
- 12:55 Vendored 0.20.0: Whombat `capabilities` aaea14c (compile fixes: pack view fields, `skill` card neutral,
  Vault `totp`, browser/propose_skill stubs; `pnpm check` 973 pass) and whombat-app `capabilities` 8d00d82 (Basic auth
  relabel, test fixtures; `pnpm check` 1181 pass). Packs content merged into Whombat `capabilities` (6e60bbb6; eleven
  packs, all `safe`, shipped test 42 pass). Packs agent notes: Anthropic's document skills are proprietary → Hermes
  MIT copies; SL-D05…D07 recorded.
- 13:00 Wave 2 started: runtime `capabilities-skills` (server skills), `capabilities-runner` (scratch sandbox, prompts,
  activity, doctor), `capabilities-spend` (spend + roles on the server); app `capabilities-web-skills`,
  `capabilities-web-core` (roles, Vault login, browser status, spend; checkpoint roster + hire modal screenshots),
  `capabilities-android`. rt-browser still in phase 1.
- 13:40 Spend + roles merged (7c055475; SP-D03…D07, AR-D05…D06; spend tests 7/7, managed 2/2, roles 7/7).
- 14:30 Browser phase 2 merged (eae9da12; tools, per-turn sessions, `DispatchContext.browser`, host info, Vault `login`
  + `browser_sign_in` + echo withhold, Test sign-in (managed export op), ARCHITECTURE “Browser”; BT-D17…D25,
  VT-D34…D36; real-Chromium tests pass with WHOMBAT_TEST_BROWSER=1). BT-D26 recorded (browser key at ask).
- 14:40 Lead docs: DECISIONS index rows, `docs/browser.md`, `docs/skills.md`.
- 15:00 Avatar checkpoint in-app shots (roster, hire grid, Lead profile, both themes) in
  `~/.cache/wb-tmp/cap-shots/checkpoint/`, shown to John; waiting for his answer before main.
- 15:10 Runner merged (f8ab6659; scratch turns, attachments copied into scratch, prompt modules roles/scratch/browser,
  skill hints in the user turn, Skill + browser activity, doctor python check; SL-D20…D28, AR-D10, BT-D30…D33).
- 15:20 Android merged into app `capabilities` (d9a8b44; AP-230…AP-239; emulator-verified; approve on phone only
  after a clean scan).
- 15:50 Skills server merged (05ca1081; SL-D08…D15, AG-35…AG-39; 1101 server tests on its branch). Integrated checks
  running; security review started (report → `~/.cache/wb-tmp/cap/security-review.md`).
- 16:30 Integrated runtime green: `pnpm check` 1184 pass, `pnpm test:server` 1101 pass.
- 16:50 web-core merged into app `capabilities` (206cf90; AP-215…AP-229; Spend tab for everyone with scope,
  Login + Test sign-in, browser row, spend line; `pnpm visual` mocked screens pass).
- 17:10 Appliance phase 2 done (branch `capabilities`; NX-99, NX-100, IN-88…IN-91): `vm-tests/browser-real.nix` 9/9
  against the real host (override input to the capabilities runtime), harness on contracts 0.20.0, `dev/up` starts the
  browser host for the dev appliance, scenarios r-browser 8/8 and s-skills-roles 6/6 on the integrated runtime, runbook
  “Putting the instance on 0.18.0”. Waiting for pins.
- 17:40 web-skills merged into app `capabilities` (706be9e; AP-200…AP-214; `pnpm visual` 229/229); app `pnpm check`
  1292 pass. Product review started (report → `~/.cache/wb-tmp/cap/product-review.md`).
- 18:30 Security review in (`~/.cache/wb-tmp/cap/security-review.md`): 0 critical, 5 high (H1 revealed password in
  signed-in screenshots, H2 server/host signed-in disagreement, H3 team-agent proposals from private rooms readable by
  everyone, H4 personal agents' own packs listable/exportable, H5 self-hosted scratch reads are a blocklist), 14 medium,
  14 low. The browser's destination filtering held (no loopback/metadata/private reach; DNS pinned). Four fix agents
  started: `capabilities-fix-browser` (H1, H2, M1, M2, M6, M14, L1–L3, L5–L7), `capabilities-fix-skills` (H3, H4, M5,
  M7, M8, L8–L10, L14), `capabilities-fix-scratch` (H5, M9–M12, L11–L13, runner SKILL.md rewrite), contracts
  `capabilities-fix` (M3 scanner, M4 nested SKILL.md, M13 deploy by role, L4 URL strip; → 0.20.1, CT-131).
- 19:20 Skills security fixes merged (2cc8f27e; SL-D40…D48, SP-D10). Consequence: a team agent proposes only from a
  conversation everyone is in, so web “Learn this” for team agents posts in a burrow-wide channel (app fix).
- 19:30 Product review in (`~/.cache/wb-tmp/cap/product-review.md`, 146 screenshots, real runtime + web): 3 must-fix
  (M1 shared `/skill` unsendable in rooms, M2 member's Attach fails silently, M3 “is a product/security” copy), 19
  should-fix, 15 nice-to-have; avatars consistent, props vanish at 22–32 px and blue/violet clusters (for John).
  Routed: contracts `capabilities-fix` + M3 role nouns, S1 row replacement, S2 `impliedBy` (CT-131, 0.20.1); runtime
  `capabilities-fix-product` (S4 proposals in Needs you + notifications, S8 no shared skill names per role, pack text
  typography); app `capabilities-fix` (M1, M2, Learn this channel, S2…S19 UI, nice-to-haves, Android S18).
- 20:40 Security fixes merged: browser/Vault (4b76dd20; BT-D40…D48, VT-D40…D41; host protocol v2), scratch/runner
  (ab3934b4; SL-D50…D59; scratch reads an allowlist, checked in Codex's real sandbox and two live Claude turns).
  Runtime product fixes merged (cd60d355; SL-D60…D63; proposals in Needs you as `question` items + needs_you
  notifications; writer-craft without docx; pack typography).
- 21:00 Contracts **0.20.1** (CT-131: scanner bypasses, nested SKILL.md, hireGrants by role, URL strip, role nouns,
  hire rows, included keys) tagged `contracts-v0.20.1` (006cac3) and released; vendored in Whombat (7467275c: hires
  pass their role; credentialed URLs leave no activity object) and app (8222bcb). Runtime `pnpm check` 1213,
  `test:server` 1146; app 1292.
- 21:30 App review fixes merged (cc54197; AP-240…AP-254; 1327 tests, visual 229/229). **whombat-app 0.11.0** tagged
  `app-v0.11.0` (ab46e95), released (`dist-release/0.11.0`, sha256 3df4d7fb…) and vendored in Whombat (b6701a5a).
  Candidate 0.18.0 handed to the appliance agent (contracts-v0.20.1, runtime b6701a5a, app ab46e95).
- 22:10 **John approved the six avatars** (AR-D20), gave Security the scratch workspace by default, left the pack
  licence to us (SL-D06 kept) and said to decide every future choice ourselves (memory `feedback-decide-yourself`).
  Contracts **0.20.2** (CT-132, cd3422d, tag `contracts-v0.20.2`), whombat-app **0.11.1** (e68fdfc, tag
  `app-v0.11.1`), vendored in Whombat (a2737a10). Mains had moved: Whombat main SUB-56 merged into `capabilities`
  (541bced4; `pnpm check` 1216, `test:server` 1146); appliance main has candidate 0.17.2 and NX-93 → our NX-93…NX-100
  become NX-94…NX-101; candidate 0.18.0 re-pinned on 0.17.2 with runtime 541bced4, app e68fdfc, contracts 0.20.2.
- 23:10 Local live checks with real Claude agents (`~/.cache/wb-tmp/cap/live-local.md`): browser (Pepper opened
  example.com and docs.python.org, clicked through, answered), scratch (Tally posted a valid .xlsx with totals and a
  chart; `scratch: true`; folder gone), delegation (Compass → Pepper, report_back, handoff_result) pass; the proposed
  skill loaded only after a workaround → runner bug: a pack with ≥ 2 skills loaded none (plugin.json rewritten
  read-only). Fixed (SL-D70, regression test) and contracts **0.20.3** (CT-133: `HANDOVER_KEYS` gains `browser.use`,
  `workspace.scratch`, so a Lead sees its Tester's browser). Runtime e8474971: `pnpm check` 1217, `test:server` 1146.
- 23:30 GitHub: the host's active gh account is now a test account (another session); pushes use the maintainer account’s token per
  command (`git -c credential.helper='!…gh auth token --user <the maintainer account>…'`), the global account unchanged.
  **Contracts main 89edf45 pushed** with tags `contracts-v0.20.0…v0.20.3`. **whombat-app main af43090 pushed** with
  `app-v0.11.0`, `app-v0.11.1`. Worktrees and branches removed. Whombat and appliance wait for candidate 0.18.0.
- 01:30 Candidate **0.18.0 validated** (appliance `capabilities`; product 2026.09.28-rc.3; base 0.17.2: control 1894faf,
  relay dff896a, components 11bf570; contracts-v0.20.3, runtime e8474971, app-v0.11.1): build 8/8, gates 17/17, scenarios
  29 files / 132 passed (r-browser 8/8, s-skills-roles 6/6; k-live-agents skipped by design), demo 2/2,
  `browser-real-runtime` VM 9/9, `browser` VM 10/10 (V-71, V-72, IN-92). Scenario fixes only (p-billing waitlist code
  bound to the joiner since 0.17.1; h4 export ops refused before running since contracts 0.20). Our appliance NX
  decisions are NX-94…NX-101 (main took NX-93). Follow-up: the runtime's refusal of a plain export op carries no
  `details.code: use_export_stream`.
- 15:55 Shipped: Whombat main 18f39551 pushed (worktrees and branches removed); appliance main 81b1421 pushed
  (candidate 0.18.0, image runtime e8474971, NX-102). Backup `~/.cache/wb-tmp/dev-backup-pre-capabilities-20260928T*`.
  Dev managed stack on 0.18.0 (`WB_MGD_PINS=manifest/candidates/0.18.0.json`, restart without --reset): schema 0048,
  browser available. Dev monolith pulled to 18f3955, `pnpm install`, `whombat browser install` into
  `~/.whombat-dev/browser`, restarted: health ok, `0048_capabilities`, browser available.
- 16:25 Live checks on the dev monolith (burrow “Capabilities check”): browser, scratch (.xlsx with totals and chart),
  Lead → Tester handoff, proposed skill approved from the card and used twice — all pass; both local-run bugs fixed.
  Evidence in `verification.md`. Done.
