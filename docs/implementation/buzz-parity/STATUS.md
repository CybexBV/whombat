# Buzz-parity status ledger

Orchestrator-maintained. States: `not-started` · `in-progress` · `implemented-unverified` · `verified` · `blocked`.

## Baseline (integration base `73dc189`, 2026-09-24)

- `TMPDIR=~/.cache/wb-tmp pnpm check`: pass (1523 unit tests, 6 skipped).
- `pnpm test:server`: 392 pass, 1 fail, 5 skipped. The failure (`agent-runtime.int.test.ts > host.info > tells members
  the home directory and the workdir roots`) is **pre-existing and environmental**: with `TMPDIR` under `$HOME` the
  server abbreviates the roots to `~/…`; it passes with `TMPDIR=/tmp`. Not a regression.

## Capabilities

| ws | state | branch / owner | depends on | acceptance evidence | remaining |
|---|---|---|---|---|---|
| foundation | verified | `buzz-parity` @ `eb44771`, `f50b476` / orchestrator | — | typecheck, 1523 unit tests, runner.int (17) green; usage persisted (migration 0014) | — |
| A attachments | verified (see completion matrix) | `bp/attachments` @ `909776e` → merged `92e16a8` | foundation | worker: files int tests (upload/serve/revocation/malformed/interrupt/quota/orphans/restart), 172/172 visual, mobile typecheck + 85 unit + debug APK built; LIVE Claude (Pippa) and Codex (Dusty) guarded turns read KESTREL-4471 from a screenshot and returned `build-id.txt`; member 200, nonmember 404 (evidence `~/.cache/wb-tmp/bp-a/evidence/`); integrated at `92e16a8`: check 1586 pass, test:server 441 pass / 0 fail | test for the integration filter (attachments limited to delivered messages); Android flow on device not run; share-in intent, web thread-pane attach, thumbnails, S3 backend and Codex PDF not done (honest notes) |
| B memory | verified (see completion matrix) | `bp/memory` @ `38778d4` → merged `ffb73f9` | foundation | worker: 23 memory int tests, live Claude continuity (evidence `~/.cache/wb-tmp/bp-b/evidence/`), 14 screenshots; integrated at `ffb73f9`: check 1546 pass, test:server 416 pass / 0 fail | security + e2e review; Android on device not run; Codex compaction not used (fresh session at 140k measured tokens) |
| C automations | verified (see completion matrix) | `bp/automations` @ `c2dc8ba` → merged `47507a1` | foundation; A/B/D for golden path | worker: 24 automation int tests (both templates e2e, approval pause + restart without replay, decline, races, changed commit/input, revoked publisher, cancel, overlap/missed policies, loop limit, webhooks dedupe/signature/replay, boot recovery, budgets), DST unit tests, 172 visual; LIVE scheduled repo check (trusted Dusty/Claude, local repo; guarded chat turns cannot read the checkout) evidence `~/.cache/wb-tmp/bp-c/evidence/`; integrated `47507a1`: check 1627 pass, test:server 467 pass / 0 fail | golden path with A/B/D; dispatch-step checkpoints (B task key) not wired; http_callback success path untested; Android on device not run |
| D packs | verified (see completion matrix) | `bp/packs` @ `d08e13b` → merged `476c7e3` | foundation | worker: packs.int 20/20 (same pin in two burrows, escalation, malicious archives, secrets, unapproved tools, re-approval on update, disabled pack), adapter unit tests, 172 visual; LIVE Claude + Codex used the UI review pack skill (evidence `~/.cache/wb-tmp/bp-d/evidence/live-ui-review.txt`); integrated: check 1673 pass, test:server 487 pass / 0 fail | security review of `KeyRequirement.grants` and the args preview in approval text; secrets-in-logs has no test; Android on device not run; behavior change: Codex no longer reads repo AGENTS.md/bundled skills (BP-D13) |
| E ACP | verified, trusted-only (see completion matrix) | `bp/acp` @ `1dd786f` → merged `1596084` | foundation, A | worker: 28 ACP fixture tests (reply/tool call, image on/off, session load, crash, malformed/oversize, permissions, slow cancel, ignored cancel, usage, process cleanup), server int test end-to-end with fake runtime, 172 visual; LIVE codex-acp 6/6 (conversation, session resume, image, disposable coding task, cancel 39 ms, unavailable runtime) + one claude-agent-acp turn + browser flow (evidence `~/.cache/wb-tmp/bp-e/evidence/`); integrated: check 1720 pass, test:server 492 pass / 0 fail | ACP is trusted-only (guarded refused: no enforceable confinement); claude-agent-acp follows the operator's Claude settings (e.g. bypassPermissions) — documented; MCP token visible to the runtime process; Android on device not run |
| F distribution | verified; arm64 built not run (see completion matrix) | `bp/distribution` @ `454c6f7` → merged `d158911` | foundation; integrated product for final smoke | worker (on A–C base): `pnpm package:acceptance` 38/38 — reproducible x64 (byte-identical rebuild), arm64 built (aarch64 ELF checked, not run), clean-env install without pnpm, init/start/sign-in/post/upload/automation/restart, upgrade of a checkout-based 73dc189 home (fingerprints, audit chain, grants, approvals, config.env preserved), concurrent upgrade lock, corrupt artifact/tampered release refused, failing migration rolled back, post-migration failure stopped with printed recovery, backup/restore incl. wrong master key refusal, diagnostics bundle without secrets; test:cli 15/15; integrated `d158911`: check 1755 pass, test:server 499 pass / 0 fail, test:cli 15/15 | acceptance on the integrated head (with D packs + E ACP); real systemd user manager not exercised (faked systemctl); arm64 not run; CI/release workflows never triggered; repo has no LICENSE file |
| security review | done: 3 rounds + targeted re-check (see findings) | `review/security*` | integrated A–F | PoCs inverted into regression tests | — |
| e2e / golden path | done: live golden path + installed-package step 8 PASS | `review/e2e*`, `review/android*` | integrated A–F | see sections below | — |

## Integration log

- `ffb73f9` merge `bp/memory` (B). Migration `0015_bp_memory` chains on `0014`. Gates: `pnpm check` pass (1546 tests),
  `pnpm test:server` (TMPDIR=/tmp) 416 pass, 0 fail.
- Finding from B: live prompts are built by `apps/runner/src/prompt.ts`, not `persona/index.ts`; the persona hooks for
  attachments/packs must be called from the runner builder too (A and D told). Pre-existing: the personal-agent
  section of the persona builder does not reach live prompts either (connectors workstream; noted for review).
- `92e16a8` merge `bp/attachments` (A). Migration regenerated as `0016_bp_attachments` (identical SQL; adds
  `conversation_id NOT NULL` — safe because uploads answered 501 before, so every existing table is empty). Integration
  change: `DispatchContext.attachments` lists only files on messages memory actually delivered; runner fetch and
  `read_attachment` use `contextWindowLimit()` (memory's candidate window). Gates: check 1586 pass, test:server 441 pass.
- `47507a1` merge `bp/automations` (C). Migration regenerated as `0017_bp_automations` (identical SQL). Integration fix:
  web webhook controls shown only to owners (server already enforced; `isOwner` prop was unused). Gates: check 1627 pass,
  test:server 467 pass / 0 fail. Follow-up commit: pre-existing flaky `personal-agents.int.test.ts` (random pool-name
  collision, `Q3` matching random ids) made deterministic.
- `476c7e3` merge `bp/packs` (D). Migration regenerated as `0018_bp_packs` (identical SQL). Gates: check 1673 pass,
  test:server 487 pass / 0 fail.
- `1596084` merge `bp/acp` (E), no conflicts, no migrations. `71f2b5a`: runner test for the first access beat made
  robust (pre-existing keep-alive race widened by turn preparation; access still reported exactly once). Gates: check
  1720 pass, test:server 492 pass / 0 fail.
- `d158911` merge `bp/distribution` (F). Conflicts: doctor imports (ACP + distribution checks kept), docs (troubleshooting
  moved to docs/troubleshooting.md with pack/ACP entries). Gates: check 1755 pass, test:server 499 pass / 0 fail, test:cli
  15/15.

## Independent review findings

Security review A–D (`review/security` @ `a5f7522`, PoC tests) and E–F (`review/security2` @ `1730d54`).

| id | sev | status | owner / fix |
|---|---|---|---|
| SEC-AUTO-RUNNOW (Run now relays private-room answers) | high | fixed (merged `2cded63`, 14 regression tests; PoCs fail after fix) | `fix/automations` |
| SEC-SKILL-GRANTS (SKILL.md `allowed-tools`/`hooks`) | high | fixed `4290fc1` (BP-D20; import refuses, runner rewrites) | orchestrator |
| SEC2-F3 (backup manifest unauthenticated → tampered restore) | high | fixed (merged `8df2a55`) | `fix/distribution` |
| SEC-AUTO-TRIGGER, SEC-AUTO-DRAFT | medium | fixed (merged `2cded63`) | `fix/automations` |
| SEC-PACK-ARGS, SEC-MEM-WIDEN | medium | fixed (merged `ec6cb85`) | `fix/packs-memory` |
| SEC2-F5 (unsigned releases), SEC2-F1 (tar symlink chains) | medium | fixed (merged `8df2a55`); F5 needs the owner to create and pin a release key | `fix/distribution` |
| SEC-HOOK-REPLAY, SEC-ATT-META, private room titles in automation list | low | fixed (merged `2cded63`) | `fix/automations` |
| SEC-MCP-BODY, SEC-PACK-HASH, upload rate/quota races, sessions keep deleted knowledge | low | fixed (merged `ec6cb85`) | `fix/packs-memory` |
| SEC2-F2, F4, F6, F7, F8, F9, F10, F11 | low | fixed (merged `8df2a55`) | `fix/distribution` |

Package acceptance on the integrated head `940a540`: 36/37 — the one failure was the test's hard-coded
"4 migrations" (the upgrade correctly applied 5, incl. `0018_bp_packs`); fixed in `4290fc1`.
Package acceptance on `6d4515b` (all six workstreams + automations, packs/memory and distribution fixes):
**41/41** (evidence `~/.cache/wb-tmp/int-acc/report.json`): reproducible signed x64 build (throwaway key, 0 pinned),
arm64 built not run, clean-env install, upgrade of a 73dc189 checkout home applying 0014–0022 with keys/events/
grants/approvals/config preserved, 0.1.0→0.1.1 upgrade with lock, refused tampered/unsigned/bad-signature artifacts,
failed-migration rollback, post-migration failure recovery, authenticated backup/restore incl. tampered-backup
refusal, lock takeover, diagnostics without secrets. (One acceptance-script fix: publish now sends the draft hash.)

### End-to-end golden-path review (`review/e2e` @ `c25e5be`, base `5113488`)

Live (Claude Code 2.1.278 + codex-cli 0.156.1, guarded, FakeGitHub bare repo) and deterministic
(`golden-path.int.test.ts`). Steps 1 (screenshot + report via web UI), 2 (investigator read a detail only in the
image, cited approved memory; pack pinned), 3 (evidence + approval with action hash), 4 (server+runner restart at
the approval, approve in the web UI, no replay), 7 (nonmember 404s/403s, agents cannot decide, no names/bodies in
audit) PASS. Steps 5–6 FAIL — blocker B1 (automation developer gets no writable worktree: `fix/*` branch asks,
no workspace on automation dispatches, approved `start_run` dispatches nobody, read-only Claude turns have no file
tools) + M1 (steps count as done regardless of outcome), M2 (failures not reported in the original thread), M3
(guarded investigators/reviewers cannot read code). Minor m1–m8. Owner: `fix/golden-path` (after
`fix/automations` merges). Fixed by the orchestrator in `44f7d76`: m7 (test race on turn file cleanup), m8
(pre-existing e2e copy mismatch). Other checks: visual 171/172 (one load timeout, re-run 8/8), e2e 40/41 (m8).

### Android verification (`review/android`, base `ee9b887`, emulator `whombat-mobile` read-only, debug APK)

Real device-level evidence (`~/.cache/wb-tmp/android/shots/`): sign-in + send PASS; attachments pickers, progress,
40 MB refusal, remove-before-send, file download/share, nonmember 404 PASS — **image rendering FAIL** (headers not
sent for an object image source → 401); memory approve/reject/delete PASS; automations list/toggle/run detail/
approval from the phone PASS; packs on/off, contents, tool chips (locked for non-admins) PASS; ACP RUNS ON with a
fake runtime PASS; touch targets PASS except upload Retry; dark mode on six new screens PASS. Owner of fixes:
`fix/mobile` (in progress, re-verifies on the emulator). Not verifiable here: upload cancel mid-transfer on a
local network; iOS (no macOS host — iOS stays config-compatible only).

## Late integration

- `bef8c91` merge `fix/golden-path` (B1 + M1–M3 + m1–m6; golden-path test steps 1–7 pass; live run via FakeGitHub
  opened PR #483 and reported back in the original thread — evidence `~/.cache/wb-tmp/fix-gp/evidence/`). Its memory
  decisions renumbered BP-B26/B27. Gates: check 1810, test:server 552 / 0 fail.
- `20cf868` merge `main` at `1c9e6c0` (rich messages; another session's work). main's `0014_message_suggestions`
  stays 0014; Buzz-parity migrations renumbered **0015–0023** (SQL unchanged, journal timestamps after main's,
  snapshots carry `messages.suggestions`; drizzle-kit reports no drift). Gates: check 1842, test:server 556 / 0 fail,
  test:cli 18/18, e2e 41/41, visual 170/172 + 2 Storybook load timeouts passing on rerun.
- `835cbc5` merge `fix/mobile` (all Android findings; emulator-verified by the fixer before the main merge). check 1856.
- Final round started on `835cbc5`: security re-review, final e2e (live golden path + installed-package step 8),
  Android smoke of the merged app.

### Android smoke on `835cbc5` (`review/android2`, emulator, debug APK)

All PASS (screenshots `~/.cache/wb-tmp/android2/shots/`): sign-in; an image message and an agent message with quick
replies render together (image loads), tapping a quick reply sends; photo + document attach and send (image renders,
text file card); memory approve; automation run waits at approval, approved from the phone, succeeds; packs on/off with
the burrow-wide confirm; RUNS ON with a fake ACP runtime (guarded refusal copy); dark mode. Two minor defects fixed in
`6a77e0f` (double “??” on approval questions; dark on-switch thumb). Not exercised there: remove-before-send, retry,
share, nonmember, switch toggle, decline, memory reject/delete (all covered by the first Android run or the fixer's
emulator run), an ACP turn from the phone.

### Final end-to-end (`review/e2e-final` @ `4f727cf`, base `835cbc5`)

- **Golden path LIVE — all PASS** (Claude Code 2.1.278 investigator + developer, codex-cli 0.156.1 reviewer, all
  guarded, FakeGitHub): web-UI report with screenshot → investigator used details only visible in the image, cited
  approved sourced knowledge, pack pinned → evidence + approval #13 → server+runner restart with identical state →
  Mara approved in the web UI, nothing replayed → developer committed on `feat/bug-1` in a worktree (pushed) →
  reviewer “Approve” → PR #483 on FakeGitHub → “Done: PR #483 is open” in the original thread; nonmember 404/403 on
  everything (decide indistinguishable from a missing request), agent token 401 on decide, no MCP decide tool.
  Evidence `~/.cache/wb-tmp/e2e-final/evidence/` (README.md index). ≈1.34M tokens.
- Deterministic `golden-path.int.test.ts`: 7/7 in 3 runs.
- **Step 8 on the installed package — all PASS**: 0.1.0 and 0.1.1 built and signed with a throwaway key; installed in
  a clean `env -i` home; populated messages, a thread, a PNG, approved instruction + knowledge, agent keys, an
  uploaded + attached pack (tools at can and ask), an automation run waiting at approval; restart, backup, upgrade
  refused while running then 0.1.0→0.1.1 — everything identical (fingerprints, audit chain, grants, messages,
  attachment bytes, memory, packs + tool approvals, pending run/approval); approving after the upgrade posted once;
  restore into a new home verified and the pending approval continued once there too.
- Gates on `835cbc5`: check 1856 pass, test:server 556 pass, test:cli 18/18.
- Defects: pack archives with `./` names (major) — fixed `27d345f`; template agents handing work on by @mention
  (minor) — guidance added (BP-C34), agents' own keys stay the boundary; web webhook hint copy — fixed `27d345f`;
  a run title chosen by an agent in a private room appears in the burrow-wide audit log (“Started a run to …”) —
  **pre-existing run behavior on main** (run events predate this work; C-10 makes the log burrow-visible), recorded,
  not changed here.

### Final security re-review (`review/security3` @ `94f4ef8`, base `835cbc5`)

Every earlier finding verified fixed (old PoCs re-run and failing for the fix's reason; bypasses looked for). No
critical/high. New: M1 agent reads (`read_conversation`, `canvas_read`) skip the BP-C31 audience rule — private-room
content can be relayed and SEC-MEM-WIDEN bypassed (CONFIRMED); M2 Grep/Glob in guarded read-only turns walk denied
roots inside a workdir (CONFIRMED, needs workspaces under a workdir root); L1 verdict read from an unrelated message
(CONFIRMED); L2 read-only export under shared /tmp (PLAUSIBLE, needs a second local user); L3 branch key classified
against the step base (hardening). Functional: approved `ask` write steps / approved `start_run` still get a
read-only sandbox. Owner: `fix/final` (in progress).


## Completion matrix (final integrated commit — see the handoff for the exact id)

States: **verified** = implemented, integrated, covered by automated tests on real Postgres and by independent review, and
exercised live or on device where stated; limits are listed.

| cap | state | entry points | backend / persistence | permissions | web | Android | failure behavior | tests / evidence |
|---|---|---|---|---|---|---|---|---|
| A attachments & artifacts | verified | composer picker/paste/drop, `api.uploads.*`, file GET, runner fetch, MCP `upload_file`/`read_attachment` | `apps/server/src/files/**`, `$WHOMBAT_HOME/files` (content-addressed, O_NOFOLLOW), `attachments` + `upload_reservations` | per-request conversation membership (404 for nonmembers, revocation), uploader-only before send, message owns its files, dispatch-bounded agent access, rate + quota under locks | chips w/ progress/cancel/retry/remove, attachment-only messages, thumbnails, lightbox, text preview | photo/document pickers, native streamed upload, image render with token, share | sniffing (raster inline only, sandbox CSP), malformed/oversize refused, interrupted upload leaves nothing ready, orphan sweep, honest “can’t open” for unsupported types | files int suites, context-window test, live Claude + Codex screenshot reading (A), live golden path, emulator runs |
| B memory & continuity | verified | agent profile → Instructions and knowledge, channel → Knowledge, MCP `remember`/`propose_instruction`/`recall`/`save_checkpoint` | `apps/server/src/memory/**`, memory items/versions/checkpoints/summaries/agent sessions/dispatch memory | owner-approved instructions (people only), origin-bound proposals, re-authorized sources, audience rule on agent reads, personal-agent privacy | modal, history, sources with labels, SOURCE field, checkpoints on runs/threads, context usage | view/approve/reject/delete | `degraded`/`unavailable` never shown as empty; failed summaries keep the old one; sessions retired on fingerprint/knowledge change | memory/continuity/origin/read-widen int tests, live continuity (B), live golden path |
| C automations | verified | sidebar Automations, editor (form + JSON import/export), templates, “describe it” → `draft_automation`, Run now/test run, webhooks | `apps/server/src/automations/**` (engine under advisory lock, leases, idempotency, timers, event cursor), 7 tables | publisher ∩ automation principal re-checked per step and per room, publish bound to reviewed draft hash, action-hash-bound approvals, redaction per viewer, human-only merges | list, editor, runs, run detail w/ steps, uncertain/needs-review actions | list, on/off, run detail, approve from phone | uncertain → needs review (no blind retry), notices in the original thread, loop/causal/budget limits, DST/overlap/missed policies | automations int suites (security, safety, templates, verdict, golden path 7/7 ×3), live golden path + restart, live repo check |
| D capability packs | verified | Settings → Packs, agent profile packs, archive/host-dir import, export | `apps/server/src/packs/**`, `$WHOMBAT_HOME/packs` (immutable, hash-checked), pack tables | configure-not-grant; tools only via `/mcp` with keys + approvals bound to tool def + content hash; admin for host code; sealed secrets; SKILL.md front matter restricted | import/inspect/diff/pin/approve/secrets/disable/remove/export | on/off, contents, tool approvals, burrow-wide confirm | malicious archives refused, unapproved tools blocked, changed tools re-asked, disabled pack removed from next dispatch | packs int + security suites, adapters tests, live Claude + Codex UI-review skill (D), live golden path pack pin |
| E generic ACP runtime | verified (trusted-only by design) | host `acp-runtimes.json`, Configure → ACP runtime, AI provider panel matrix, doctor | `packages/agent-runtime/src/acp/**` (official `@agentclientprotocol/sdk` 1.5.0) | owner-admin picks runtime; guarded turns refused; env scrubbed; never allow_always; runtimes file ownership checks | provider picker + capability matrix | RUNS ON section | crash/malformed/oversize/cancel handled with process-group kill; unavailable runtime reported | 28 fixture tests, server e2e with fake runtime, live codex-acp 6/6 + claude-agent-acp turn (E), emulator RUNS ON |
| F distribution & ops | verified (arm64 built not run; real systemd not exercised) | `pnpm package`, `bin/whombat install`, `whombat upgrade/backup/restore/diagnostics/doctor --json/version` | `apps/cli/**`, `scripts/package/**`, release layout apart from WHOMBAT_HOME, CI package job + manual gated release workflow | signed SHA256SUMS (no key pinned yet), authenticated backups, maintenance lock + migration advisory lock, schema-compat refusal | — | — | rollback before migration, stop-with-recovery after, tampered/unsigned artifacts refused | `pnpm package:acceptance` 41/41, test:cli 18/18, step 8 on installed package (final e2e) |

- Audit verification on the final code: fresh DB migrated + seeded → `audit:verify` “burrow-hq: OK · 52 events”.

### Targeted re-check of the final fixes (`review/security4` @ `fbd62c1`, base `fe76449`)

All six final-round findings verified FIXED (old PoCs fail for the fix's reason; bypass search per fix, incl. every
MCP tool/runner endpoint returning conversation content and the `writeApproved` binding). New: SEC4-GREP-GITDIR
(medium) and SEC4-CANVAS-EDIT-ORACLE (low) — fixed in `78d9a5e` with regression tests from the PoCs (BP-C41);
SEC4-STDIO-INLINE (low, admin-gated) — scope recorded as BP-D25 (admin approval of host-code packs is the boundary);
residual: guarded shells can read the working directory's `.git/config` — recorded in BP-C41 (keep tokens out of
remote URLs; Whombat never needs them there).

## Final gates — all on integrated commit `e4d2bd1` (logs `~/.cache/wb-tmp/final-e4d2bd1/`)

| gate | result |
|---|---|
| `TMPDIR=~/.cache/wb-tmp pnpm check` (biome + typecheck + unit) | pass — 1880 tests, 6 skipped |
| `pnpm test:server` (TMPDIR=/tmp, real Postgres, throwaway DBs) | pass — 569 tests, 15 skipped (opt-in live suites), 0 failed |
| `pnpm test:cli` (embedded Postgres) | pass — 18/18 |
| `pnpm package:acceptance` | pass — 41/41 steps |
| `pnpm visual` (both themes) | pass — 172/172 |
| `pnpm e2e` | pass — 41/41 |
| `audit:verify` (fresh migrated + seeded DB, code unchanged since `fe76449`) | burrow-hq OK, 52 events |

The only commit after `e4d2bd1` is this ledger update (docs only).
