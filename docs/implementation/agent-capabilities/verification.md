# Agent capabilities — verification

Evidence that the assignment's section 9 holds. Raw reports and screenshots are under `~/.cache/wb-tmp/cap/` on the
build machine (`security-review.md`, `product-review.md`, `live-local.md`, `live-dev.md`, `*-shots/`).

## Automated

| What | Result |
|---|---|
| Contracts 0.20.3 `pnpm check` + release smoke + `gen:check` | 1114 tests; 33 subpaths from 7 packages; no Go/schema/vector drift |
| Whombat `pnpm check` (main 18f3955 = capabilities e8474971 + docs) | 1217 passed, 13 skipped |
| Whombat `pnpm test:server` (real Postgres) | 1146 passed, 21 skipped |
| Real-Chromium browser tests (`WHOMBAT_TEST_BROWSER=1`) | host 20/20; server end to end pass |
| whombat-app 0.11.1 `pnpm check` / `pnpm visual` | 1327 tests / 229 passed (1440×900, light and dark) |
| Android | emulator run of the capability screens (AP-230…AP-239); review fixes unit-tested |
| Candidate 0.18.0 (`harness validate`, V-72) | build 8/8, gates 17/17, scenarios 132 passed (r-browser 8/8, s-skills-roles 6/6), demo 2/2 |
| Appliance VM tests | `browser-real-runtime` 9/9 on e8474971, `browser` 10/10 |

## Reviews

- **Security** (0 critical, 5 high, 14 medium, 14 low): every finding fixed with a regression test — browser/Vault
  (BT-D40…D48, VT-D40…D41), skills/packs/spend (SL-D40…D48, SP-D10), scratch/runner (SL-D50…D59), contracts 0.20.1
  (CT-131). The browser's destination filtering held from the start (no loopback, link-local, metadata or private
  reach; DNS pinned).
- **Product** (3 must-fix, 19 should-fix, 15 nice-to-have): fixed in contracts 0.20.1 (role nouns, hire rows, included
  keys), the runtime (SL-D60…D63) and the app (AP-240…AP-254).

## Live, real Claude agents

Local throwaway instance first (found SL-D70 and CT-133), then **the dev monolith** (`whombat-dev`, main 18f3955,
burrow “Capabilities check”, 2026-09-28 16:08–16:25):

| Check | Evidence |
|---|---|
| Browser | Pepper (Tester) opened example.com and docs.python.org, clicked through to the Tutorial and quoted both (`dsp_i_GvXDtSWWZn`, 16 s); activity “Opened example.com”; three hidden `browser.used` events with the origin only. |
| Scratch workspace | Tally (Analyst) loaded the Documents `xlsx` skill (`skill_uses` row), turned an uploaded CSV into `quarterly_sales.xlsx` with SUM totals and a bar chart (`att_ib2QBKGI8TbK`, `TurnAccess.scratch: true`); the folder was gone half a second after the turn. |
| Delegation | Compass (Lead) → Pepper: plan `pln_UHMIyDjPaEoG`, lane `msg_rJcCvw4gcZuK`, `report_back` done, Compass's answer; its teammates block listed Pepper's “Use a web browser” and scratch keys. |
| Proposed skill | `skp_OVNOT2xNqlA9` scanned safe, approved from the card in the web UI (own-compass 1.0.0), then used twice — `skillHint` over the API and `/release-notes-three-bullets` typed in the composer — each with a `Skill` activity and a `skill_uses` row; lead-craft's three skills loaded alongside. |

8 turns, 1.82 M input / 18 k output tokens, $1.99 (matches `spend.overview`).

## Deployed

- Dev managed stack (dev.whombat.com): candidate 0.18.0 (runtime e8474971, app e68fdfc, contracts 0.20.3), schema
  0048, “browser available” (Chromium 153), relay connected.
- Dev monolith (`whombat-dev`, 127.0.0.1:4420): main 18f3955, `0048_capabilities`, Chromium 153.0.8010.12 from
  `whombat browser install` in `~/.whombat-dev/browser`, health ok.
- Backup before both: `~/.cache/wb-tmp/dev-backup-pre-capabilities-20260928T*` (three pg dumps, `stack-dev.env`, the
  `env/` archive, the monolith's `whombat backup` and `config.env`).
- Production: not deployed.

## Follow-ups (not blocking)

- A skill that names a Whombat tool by its bare name (`post_card`) costs one failed tool call before the model uses the
  full name; the skill-authoring guidance could say so.
- Files still go to `upload_file` as base64 through the model (slow for spreadsheets); a path-based upload from the
  scratch folder would help.
- Hosts without python-docx/openpyxl/python-pptx/pypdf/Pillow warn in `whombat doctor`; skills fall back to writing
  files by hand.
- Claude Code keeps each turn's transcript in `~/.claude/projects/-tmp-whombat-runner-*` after the scratch folder is
  removed (attachments included) — a retention question for all turns, not only scratch ones.
- The self-hosted profile's RUNS ON line says “No sign-in chosen” for agents that run on the host's own login
  (pre-existing, provider-subscriptions area).
- The runtime's refusal of a plain export op carries no `details.code: use_export_stream` (appliance h4 note).
