# Tested version manifest

Machine-readable: `manifest/pins.json` (product version **2026.09.26-rc.1**, promoted after V-38; control rename candidate rc.2 is `manifest/candidates/0.6.0.json`, not promoted, V-39 / E-01) and
`manifest/candidates/0.5.4.json`; per-component digests in `manifest/product-manifest.json`.

| Component | Repository | Ref | Commit |
|---|---|---|---|
| Contracts | the contracts’ own repository then (today `packages/` and `contracts/` here) | contracts-v0.5.4 | e0e74d5 |
| Runtime (server, runner, CLI) | Whombat | managed/hardening | 5530a0e |
| Hosted UI + Android | the app’s own repository then (today `apps/` here) | main | f944e7c |
| Control | control’s own repository then (today the private whombat-cloud) | main | ffbff64 |
| Relay | the relay’s own repository then (today the private whombat-cloud) | main | 2dc2d8a |
| Manager, helper, backup, provisioning, NixOS | the appliance’s own repository then (today `appliance/` here) | main | 35e9a4c (pins) |

Pinned upstreams: nixos-26.05 (c508844), lanzaboote v1.1.0, go-tuf v2.4.2, @libp2p/noise 17.0.3, Claude Code 2.1.278
(Agent SDK 0.3.278), Codex CLI 0.157.0, PostgreSQL 17, restic 0.18 / rest-server 0.14.0. SBOMs: `release/out/`.
Upgrade paths: `docs/release/compatibility.md`.
