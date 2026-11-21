# Blockers and external release gates

| ID | Blocker | Blocks | Owner / action |
|---|---|---|---|
| X-01 | Anthropic Commercial Terms acceptance (subscription use of the unmodified hosted binary is settled as permitted, 2026-09-26, Whombat SUB-01) | preinstalling/running Claude Code in the product | Product owner |
| X-02 | ~~OpenAI confirmation for ChatGPT sign-in in a third-party appliance~~ resolved 2026-09-26: permitted per OpenAI's Codex auth docs (Whombat SUB-01) | — | — |
| X-03 | `write:packages` scope for GitHub Packages (vendored tarballs used meanwhile, MA-02) | registry publishing | John: `gh auth refresh -s write:packages` if a registry is wanted |
| X-04 | Sold hardware for power-loss, watchdog, firmware, TPM, Secure Boot qualification | R-55, R-56, R-57 | Hardware selection |
| X-05 | Production signing roots, admission/assignment keys, the licence signing key and the image's pinned licence key set (LC-03/LC-04: a prod image without `whombat.licence.keys` doesn't build), push credentials, cloud accounts | production release | John / release custody |
| X-06 | Live deployment authorization (DNS, app.whombat.com cutover) | cutover | John |
| X-07 | Qualified CRA / privacy / hardware compliance review | commercial launch | Product owner |

## Findings affecting the current (live) self-hosted product — not acted on by this assignment
| ID | Finding | Where fixed | Note |
|---|---|---|---|
| L-01 | Runner claim long poll aborted on the request's `close` event (Node ≥16 fires it after the body is read), so runners claim ~2×/s instead of holding 25 s — wasted DB transactions, present on Whombat `main` since 2026-09-23 | Whombat `managed/hardening` 55b6d77 (`disconnectSignal(reply)`) | **Resolved on dev 2026-09-26**: John asked to merge managed/hardening into Whombat main (89ab1c6) and deploy dev.whombat.com; production not deployed. |

## Open engineering items
| ID | Item | Blocks | Note |
|---|---|---|---|
| E-01 | The manager misses a runtime restart that fits between two health probes (MG-27), so the runtime has no update facts until the 300 s resend; h3 fails deterministically in V-39 | promoting rc.2 (`manifest/candidates/0.6.0.json`) | Fix idea: `RuntimeHealth` carries a per-boot instance id and the manager re-sends when it changes (contracts 0.6.1, runtime, manager) |
| E-02 | Whombat `pnpm package:acceptance` fails: the packaged self-hosted install can't load `node-pty`'s native module (`pty.node` not shipped), a dependency since 24b2cbd (Claude sign-in console in a PTY) | self-hosted package releases (not the appliance candidate, whose gates don't run it) | Found 2026-09-26 during the licence work; recorded in Whombat `docs/decisions/managed-runtime.md` open items; fix in the packaging step (ship the prebuild for each target) |
| E-03 | The new Android screens of whombat-app 0.3.0 (terms at claim, identity hard stop, set-up screen, add-a-device link, Subscription section, account deletion) are covered by typecheck and unit tests only; the device harness drives the session layer, not these screens | Android release of 0.3.0 | Emulator walk-through of the journeys (AP-63…AP-74) |

## Product-owner decisions needed (not engineering blockers)
| ID | Decision | Where |
|---|---|---|
| D-01 | ~~First-party licence for all six repositories~~ **resolved 2026-09-26**: whombat-app and whombat-contracts are PolyForm Strict + research permission (SR-02); Whombat, control, the relay and the appliance carry a proprietary `LICENSE` and `"license": "UNLICENSED"` (LC-19). Remaining: legal review of the notice wording and of the appliance terms (D-06) | docs/release/sbom.md, docs/decisions/licence.md |
| D-02 | GPL source-offer process for the NixOS image (117 copyleft packages) | docs/release/sbom.md |
| D-03 | RL-01…RL-04: pilot host, rehearse on dev first, legacy window, no import until built | docs/release/decisions.md |
| D-04 | Deploy production (app.whombat.com) with Whombat main 89ab1c6 — only on John's instruction | blockers.md L-01 |
| D-06 | ~~Legal review of the draft appliance terms and of the proprietary notice wording~~ **resolved 2026-11-15** (LC-24: the terms `2026-11-15` are final, and the code is AGPL-3.0); plan definitions and prices (licence limits per plan: devices, members, agents, connectors, self-install; LC-11, LC-15); whether and how to distribute the self-install ISO publicly (LC-15) | docs/decisions/licence.md |
| D-05 | Support, security-intake and privacy contacts; pilot agreement. Security intake decided 2026-09-26: security@whombat.com (SR-04); the mailbox must exist before the clients are published | docs/release/pilot.md, docs/decisions/source-review.md |
