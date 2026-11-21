# Assignment: connections that sign in properly

Spec: `docs/decisions/connection-signin.md` (SG-01…SG-22) in this branch. Research behind it, with exact request and
answer shapes and sources: `~/.cache/wb-tmp/cr/research-home.md` (Home Assistant, Nextcloud, Paperless-ngx, Immich,
Portainer, Grafana, Forgejo/Gitea), `research-infra.md` (Proxmox, UniFi, OPNsense, Unraid, TrueNAS, Synology, QNAP),
`research-session.md` (Pi-hole, NPM, AdGuard, ESPHome, Seerr, SABnzbd, NZBHydra2, email), `research-cloud.md` (cloud
services, MCP sign-in). Read the sections for your items before building; they cite file:line in our code.

Lead: session whombat-67 (merges, releases, ships). Integration branch: Whombat `csi` (`~/Code/.wt/whombat-csi`), app
`csi` (`~/Code/.wt/app-csi`), contracts `csi` (`~/Code/.wt/contracts-csi`).

## Streams and worktrees

| Stream | Worktree (branch) | Items | Numbers |
| --- | --- | --- | --- |
| C contracts 0.111.0 | `~/Code/.wt/contracts-csi` (csi) | every schema and catalog change | CT-730…CT-769 |
| S1 server: sign-in kinds | `~/Code/.wt/whombat-csi-s1` (csi-s1) | SG-01…SG-12 | SG-S01…SG-S29, migration 0128 |
| S2 server: services | `~/Code/.wt/whombat-csi-s2` (csi-s2) | SG-13…SG-20 | SG-S30…SG-S59 |
| W app: shared client + web | `~/Code/.wt/app-csi` (csi) | client side of SG-01…SG-22 | AP-3900…AP-3949 |
| A app: phone | `~/Code/.wt/app-csi-mobile` (csi-mobile) | phone side of SG-01, SG-06, SG-09 | AP-3950…AP-3999 |

Contracts first: C lands the schemas (SG-02 endpoints, `service_login`, `login.challenge`/`details.challenge`,
`twoStep` + `code`, `SessionFailure.status`, check `failures` and `forSecret`, field `fromCheck`) and the catalog entries
S1/S2 depend on, and builds a provisional `dist-release/0.111.0`; the lead vendors it into Whombat `csi` and app `csi`;
S1, S2, W and A merge `csi` then. Until then build what doesn't need the new schema. C then finishes the copy (SG-20,
SG-21) and the lead re-vendors the final release.

Rules for every stream:
- Read the repo's CLAUDE.md / ARCHITECTURE.md / DECISIONS.md first; follow its conventions, decision files and test rules.
- Commit on your branch (small, imperative, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
  **Never push, never merge into main, never tag or release**: the lead does that.
- DEV is fast: one quick check per repo when you finish (`pnpm format` then `pnpm check`; S1/S2 also `pnpm test:server`
  once, or only the integration files you touched when the full run is slow). No VM tests, no CI, no waiting.
  One repo's full check at a time on this machine.
- `TMPDIR=/home/me/.cache/wb-tmp`, Node 24 (`export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`).
  Server tests use the shared Postgres :55432 with your own throwaway databases; never stop or reset shared containers.
- Never sign in to a real service, never send credentials anywhere, never POST to a third-party endpoint while building:
  tests use fakes. Unit-test the parsing and the decisions (which refusal, which words, which request), not long
  sentences (check the facts a message carries: names, ids, a short key phrase).
- Visible words are plain and short (concise-replies.md); copy in the spec is verbatim (curly quotes ’ “ ”, `·`, `…`).
- Record decisions you take under your number range in `docs/decisions/connection-signin.md` (Whombat) or the repo's own
  decision file (contracts `docs/decisions/contracts.md`, app its decision file).
