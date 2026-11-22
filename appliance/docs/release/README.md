# Release package — Whombat managed appliance

Index of the release, pilot and operations material for the **0.5.2 release candidate** (product version
2026.09.25-dev.4, release id `rt-2026.09.25-dev.4`, pinned in `manifest/pins.json`; appliance main b76a417,
evidence V-30), and the exact release checklist with the state of every item.

Nothing in this package has been deployed, published, signed with production keys or sent to anyone.

## Contents

| Document | What it is |
|---|---|
| [`sbom.md`](sbom.md) | How `release/sbom` works, tools and versions, provenance, the 0.5.2 license inventory and vulnerability triage, and what isn't covered |
| `../../release/out/2026.09.25-dev.4/` | Generated output: `sbom/*.cdx.json` (22 CycloneDX 1.6 SBOMs, 3 SPDX), `licenses.{md,json}`, `vulnerabilities.{md,json}`, `provenance.json`, `SHA256SUMS` |
| `../../release/sbom`, `../../release/lib/summarize.ts`, `../../release/policy/{licenses,triage}.json` | The script, the summarizer, the license policy and the triage decisions |
| [`compatibility.md`](compatibility.md) | Compatibility policy: one contracts major for clients and box, update classes, schema rollback classes, the manager↔runtime IPC across a class update, long-offline boxes |
| [`pilot.md`](pilot.md) | Pilot package for customers: what they get, claim, recovery kit, backups, provider sign-in, support, known limits |
| [`lifecycle-procedures.md`](lifecycle-procedures.md) | Key rotation, staff departure, lost storage, stolen devices, ownership transfer, appliance loss, kit loss (R-20) |
| [`decisions.md`](decisions.md) | Release workstream decisions RL-01…RL-08 (RL-01…RL-04 await John) |
| [`../archive/cutover.md`](../archive/cutover.md) | Reversible cutover from the self-hosted monolith, phase by phase (archived: the monolith is retired, HE-48) |
| [`../runbooks/rollback.md`](../runbooks/rollback.md) | The rollback of every cutover step and the per-org point of no return |
| [`../runbooks/pilot.md`](../runbooks/pilot.md) | Operator procedure for running a pilot org |
| [`../runbooks/support.md`](../runbooks/support.md) | Support ground rules, visibility, ticket handling, diagnostic bundle (exists vs. missing) |
| [`../runbooks/incident-appliance.md`](../runbooks/incident-appliance.md) | Appliance incidents: can't connect, update stuck/quarantined, backup failing, recovery; links to control/relay runbooks |
| [`../runbooks/vulnerability-response.md`](../runbooks/vulnerability-response.md) | Intake, triage SLAs, fleet rollout and emergency stop, disclosure, CRA notes |

Existing runbooks this package builds on (not changed here): `updates.md`, `updates-release-signing.md`,
`backup.md`, `restore.md`, `replacement.md`, `recovery-export.md`, `factory-reset.md`, `rma.md`,
`provisioning.md`, `hardware-qualification.md`, `acceptance.md`, `local-dev.md`; control
`docs/runbooks/*` and the relay `docs/runbooks/*`.

## Release checklist (0.5.2 RC)

States: **done** — performed, with evidence; **external-gate** — waits for a named external decision, credential,
hardware or deployment authorization (`docs/implementation/blockers.md`); **not-run** — could be done by us but
hasn't been (or isn't built). “Done” never means “ready for commercial production”.

### Build and integration

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | Every pinned component builds from a clean clone at its commit (frozen lockfiles) | done | V-30 (8/8); again in the `release/sbom` run 20260925T212352Z (build run 2026-09-25-2123) |
| 2 | Repository gates at the pins | done | V-30 (15/15) |
| 3 | Cross-repo scenarios (slice B, enrollment negatives, hostile relay, durable commands, revocation, pairing, recovery kit, push, slice C1–C6) | done | V-30 (46/46) |
| 4 | 30-minute soak, no errors, bounded RSS | done | V-30 |
| 5 | Scripted acceptance demo | done | V-30 (16/16) |
| 6 | Appliance Go tests (race) and VM suites `install-boot-luks`, `recovery-tpm`, `manager-units`; builds `appliance-toplevel`, `image-no-secrets` | done | V-29 (at 979d1ac, merged into the pinned 62eb943 with ledger-only changes after it) |
| 7 | VM suites `sandbox-backup`, `appliance-basic` | not-run at the pin | last green at 96a90c5 (V-28); not re-run at 62eb943 |
| 8 | Runtime Nix closure and provider bundles built and placed in a signed release tuple | not-run (not built) | pins placeholders (W2-NX / W2-RT / W3-PV) |
| 9 | Secure channel in Node, Chromium, Firefox, WebKit, Hermes | done | V-26 (contracts 0.5.2), V-12 |
| 10 | Android journeys on the 0.5.2 pins | not-run | V-24 ran on the 0.5.1 candidate (app ed80bea), not on d89ddcb |
| 11 | Physical ARM Android phone; iOS app | not-run / not built | N-01 |
| 12 | Warm regional encrypted echo p95 < 100 ms through a deployed relay | external-gate (cloud deployment, X-05/X-06) | N-03; loopback numbers only (V-30) |
| 13 | Sold-hardware qualification: power loss, watchdog, TPM, Secure Boot, firmware | external-gate (X-04) | `hardware-qualification.md`; VM-only so far (V-29) |
| 14 | Independent security review | partly done | parts 1–2 fixed and re-reviewed (V-25, V-29); no review of the 0.5.2 RC as a whole (R-79 open) |

### Supply chain

| # | Item | State | Evidence |
|---|---|---|---|
| 15 | CycloneDX SBOM per pinned component (contracts, runtime, app web + mobile JS + Android, control, relay, appliance Go, NixOS closure, provider CLIs) | done | `release/sbom` run 20260925T212352Z; `sbom.md` |
| 16 | Merged license inventory with copyleft / non-OSI / proprietary / unknown flags | done | `release/out/…/licenses.md` (218 flagged shipped rows, 0 unknown) |
| 17 | Qualified review of the license inventory (GPL source offer for the image, Google Play/ML Kit terms, provider binaries) | external-gate (X-07; X-01/X-02 for the provider binaries) | `sbom.md` “License inventory” |
| 18 | First-party license or proprietary notice declared in every repository | external-gate (product owner decision) | none declared today (`sbom.md`) |
| 19 | Provenance record (commits, build commands, artifact digests, tool versions) | done | `release/out/…/provenance.json` |
| 20 | Signed build attestations (SLSA/in-toto) | not-run (not built) | `sbom.md` “Provenance” |
| 21 | Reproducible contracts Go tarball | not-run | rebuilt digest differs every build (`provenance.json`, manifest build report) |
| 22 | Vulnerability scan of every SBOM with triage decisions | done | `release/out/…/vulnerabilities.md`: 177 rows, 0 untriaged |
| 23 | Fix the affected finding: golang.org/x/text ≥ v0.39.0 in the appliance (whombat-backup links the vulnerable code); bump x/crypto ≥ v0.56.0 | not-run | triage `affected` / `fix-planned` |
| 24 | Resolve the 67 NixOS-closure findings under investigation (nixos-26.05 bump + rescan) | not-run | triage `under-investigation` (W2-NX) |
| 25 | Resolve the 3 Android findings under investigation (commons-io, gson) | not-run | triage `under-investigation` (W2-APP) |
| 26 | Vulnerability-response process with contacts and SLAs | done (written); contacts external-gate | `vulnerability-response.md` §9 |

### Keys, custody and environments

| # | Item | State | Evidence |
|---|---|---|---|
| 27 | Production TUF root ceremony and targets custody | external-gate (X-05) | `updates-release-signing.md` |
| 28 | Production admission and assignment keyrings, push credentials (APNs/FCM/VAPID), SMTP | external-gate (X-05) | control `infra/README.md` §3 |
| 29 | Distinct dev/prod environments deployed and verified | external-gate (X-05/X-06) | defined in control infra; nothing deployed |
| 30 | Development-key update fixtures and TUF tests (replay, expiry, rotation, long offline) | done | V-08, V-15, V-21; slice C5 in V-30 |

### Product, legal and providers

| # | Item | State | Evidence |
|---|---|---|---|
| 31 | Anthropic commercial terms / subscription use (Claude) | done (no longer a requirement, John 2026-11-22, Whombat SUB-59) | `provider-evidence.md` |
| 32 | OpenAI confirmation for ChatGPT sign-in (Codex) | external-gate (X-02) | `provider-evidence.md` |
| 33 | Real provider login from a remote browser with authorized accounts, persistence across update | external-gate (authorized credentials) | synthetic provider only in V-30; §14.9 not run |
| 34 | Qualified CRA / privacy / hardware compliance review, support period decision | external-gate (X-07) | `vulnerability-response.md` §8 |
| 35 | Compatibility policy | done | `compatibility.md` (one contracts major, HE-52; IN-417) |
| 36 | Client security floor mechanism | dropped (HE-52: one contracts major, no client floors) | `compatibility.md` |
| 37 | Lifecycle procedures (R-20) | done (written) | `lifecycle-procedures.md`; gaps marked there |
| 38 | Recovery-key replacement after kit loss; re-enrollment of device-less accounts | not-run (not built) | `lifecycle-procedures.md` §3, §8; MR-23 |

### Pilot and cutover

| # | Item | State | Evidence |
|---|---|---|---|
| 39 | Pilot package and operator procedure | done (written) | `pilot.md`, `../runbooks/pilot.md` |
| 40 | Support and appliance incident runbooks | done (written, not exercised) | `../runbooks/support.md`, `../runbooks/incident-appliance.md` |
| 41 | Customer-approved diagnostic bundle (local, previewable, scoped, expiring, audited) | not-run (not built) | `../runbooks/support.md` §4; R-70 |
| 42 | Cutover plan and rollback | done (written, not executed) | `../archive/cutover.md`, `../runbooks/rollback.md` |
| 43 | Decisions RL-01…RL-04 (pilot host, dev first, legacy window, no import yet) | external-gate (John) | `decisions.md` |
| 44 | Legacy import dry run on restored copies of the dev and prod instances | external-gate (John: access to the live instances' backups) | `../archive/cutover.md` phase 2 |
| 45 | Legacy import (write path) and re-enrollment ceremony | not-run (not built) | MR-18 (dry run only), MR-23 |
| 46 | Production control and relay deployed; DNS for new hosts | external-gate (X-06) | `../archive/cutover.md` phases 1, 3 |
| 47 | Control DB backup/restore test on the deployed stack | not-run (needs 46) | control `control-db-backup-restore.md` §4 |
| 48 | Support contacts, security intake, pilot agreement | external-gate (product owner) | `pilot.md`, `../runbooks/support.md` §5 |

## For the ledger (orchestrator)

Proposed verification entry (not written to `docs/implementation/` by this workstream):

> **V-31** 2026-09-25 · 0.5.2 RC pins (contracts 25e23ea, runtime 52c3ff2, app d89ddcb, control a1d74d1, relay
> 2dc2d8a, appliance 62eb943) · `TMPDIR=~/.cache/wb-tmp release/sbom` (appliance `release` branch) · fresh clean
> clones (manifest build run 2026-09-25-2123), 74/74 steps ok: 22 CycloneDX SBOMs (+3 SPDX), 3440 component rows,
> 218 flagged shipped license rows (no first-party license declared; 117 strong-copyleft in the NixOS closure; 17
> non-OSI Google terms on Android; 4 proprietary: Claude/Codex binaries, Claude Agent SDK), 177 vulnerability rows
> all triaged (1 affected: x/text in whombat-backup; 67 NixOS rows under investigation pending a nixpkgs bump; 3
> Android rows under investigation). Tools: pnpm 12.3.4, cyclonedx-gomod 1.10.0, CycloneDX Gradle plugin 3.4.1,
> sbomnix 1.7.6, grype 0.112.0 (DB 2026-09-25T06:31Z), osv-scanner 2.3.3, govulncheck 1.3.0 (vuln.go.dev
> 2026-09-24T20:07Z).

Requirement status suggestions: R-78 → IQ (SBOM/licenses/provenance/vulnerability process implemented; signed
attestations, VEX export and qualified review outstanding); R-77 → IQ for the cutover plan and runbooks (import
write path not built); R-20 → IQ (procedures written; kit-loss replacement and device-less re-enrollment not
built); R-70 remains open (diagnostic bundle not built); R-68 policy written (security floor not built).
