# One agent — the brief

Spec: `docs/decisions/one-agent.md` (OA-01…OA-24). Read it first, then `inventory.md` beside this brief (every file that
exists only because there could be more than one agent, by repository: W = Whombat, C = whombat-contracts,
A = whombat-app, P = the appliance), `CLAUDE.md`, `ARCHITECTURE.md`. The product is unreleased: **delete, don't
deprecate** — no compatibility shims, no “old clients”, no feature flags kept for old phones, no migrations of old data.
Lead: session whombat-b0 (the orchestrator).

## Numbers (claimed)

- contracts **0.123.0**, CT-1100…CT-1139
- whombat-app **0.125.0**, AP-4900…AP-4999 (client AP-4900…4919, web AP-4920…4959, phone AP-4960…4999)
- Whombat: decisions OA-*, server details OA-S01… (SA OA-S01…S39, SB OA-S40…S79, SC OA-S80…S99) appended under
  “Server details” in `docs/decisions/one-agent.md` on your branch; temporary migrations **0137** (SA) and **0138** (SB)
  while you work — SC replaces every migration by one baseline
- appliance IN-389…IN-399, console CG-336…CG-345 · control CL-132…CL-139

## Repositories, branches, worktrees

Integration branches `one-agent` (only the lead merges into them): contracts `~/Code/.wt/contracts-oa` · Whombat
`~/Code/.wt/whombat-one-agent` · whombat-app `~/Code/.wt/app-oa` · appliance `~/Code/.wt/appliance-oa` · control
`~/Code/.wt/api-oa`.

Streams: each its own worktree and branch off `one-agent`
(`git -C <repo> worktree add -b oa-<x> ~/Code/.wt/<repo>-oa-<x> one-agent`); small commits (`server: …`, imperative,
ending with the Co-Authored-By line of CLAUDE.md); never push, never merge into `main` or `one-agent`. When the lead
says “merge one-agent”, `git merge one-agent` into your branch.

| Stream | Repo | Owns |
|---|---|---|
| C | contracts | everything in whombat-contracts: `packages/core` (domain, contracts, keys, text, vault), `packages/protocol` (session ops, features), `packages/control-contracts` (plan limits), fixtures, `pnpm gen` (schema, vectors, Go), `docs/decisions/contracts.md` notes. Builds a provisional `dist-release/0.123.0` the lead vendors. |
| SA identity | Whombat | the agent itself and privacy: `commands/{agents,people,burrows}.ts`, `domain/{personal-agents,personal-dm,crew-retirement,hand-over,retired-settle,offboarding,assistant-names,licence-usage,members}.ts`, `keys/**`, `vault/**`, `memory/**`, `managed/providers/**`, `managed/runtime-features.ts`, `managed/licence*`, `home/**`, `config.ts`, `index.ts` boot steps, `seed/**`, `demo/**`, `connections/**` (caretaker, personal connections), `feedback/**`, `github/{actors,sync,checks-wake}.ts`, `automations/**`, `skills/**` and `W/skills/` (category names), `read/{spend,principals}.ts`, `backups/**`, `db/schema/principals.ts` and the agent-only columns of inventory §8 (migration 0137); `packages/agent-runtime/src/{providers,persona/{roles,personal,whombat,vault}.ts}`, `apps/runner/src/turn/credentials.ts`. OA-01…05, 08…13, 15…19. |
| SB conversations | Whombat | delegation, routing and people chat: `domain/{handoffs,handoff-stops,handoff-usage,assistant-reach,dispatch,messages}.ts`, `commands/{handoffs,pass-on,ask-agent,content,plans}.ts`, conversations/channels/DMs/members, `welcome/**`, `chats/**`, `runtime/**` (incl. `context.ts`: OA-10's “what a turn sees” lives here), `mcp/**`, `read/work-overview.ts`, search/notifications/collab/files where they assume channels or other agents, the schema of conversations, messages, dispatches, plans, welcomes, routing_log (migration 0138); `packages/agent-runtime/src/{persona/handoffs.ts,scripted/**}`, `apps/runner/src/{prompt.ts,handoffs*}`. OA-04, 06, 07, 10 (context), 14. |
| SC baseline | Whombat | after SA and SB are merged: OA-20 (one `0000_baseline` from the schema, `compat.json` and `meta/` started again, the crew's data migrations and old-data boot steps removed, migration-specific tests removed), OA-03's test default, the whole `pnpm test:server` green, `ARCHITECTURE.md` and `DECISIONS.md` brought up to date. |
| W web | whombat-app | `packages/client/**`, `apps/web/**`, `packages/avatars` (faces kept) — after C's provisional dist is vendored on `app-oa` (start deleting before: removing uses of old exports is safe). Settings → Agent (OA-09), onboarding (OA-13), no channels/people DMs/agents list/hire/roles/handoffs/reply-to/Ask-an-agent/caretaker/assessor pickers. Visual check against the existing screens in both themes at 1440×900. |
| M phone | whombat-app | `apps/mobile/**`, after W's client part is in `one-agent`; same as W on Android, 44 px targets. |
| P appliance | appliance, control, website | harness scenarios and devbox checks (OA-22), dev scripts that onboard with roles, console avatars vendor, the licence's agent count; control's plan limits and admin panel (OA-02); the website's “Hire your agents” copy (OA-23, commit, don't publish). |

A file outside your column: keep the change to the lines your decision needs and name it in your report, or ask the
lead.

## Rules for every stream

- Node 24 and TMPDIR: `export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`,
  `export TMPDIR=/home/me/.cache/wb-tmp`. Postgres :55432, your own throwaway databases only; never stop or reset
  shared containers.
- Search only inside your worktrees and the repositories named here; never `find`/`grep` over `/` or `$HOME`.
- Tests: delete the tests of what is deleted; for what changes, test facts (ids, names, counts, codes), not long
  literal text (`docs/decisions/test-speed.md`).
- Words people see follow `docs/decisions/concise-replies.md`: the agent by its name, plain English, no “agents”,
  “crew”, “hire”, roles.
- Don't touch production, the DEV box or the dev stack: the lead ships.

## Finishing a stream

`pnpm format`, then your repo's check (Whombat: `TMPDIR=~/.cache/wb-tmp pnpm check`; SA/SB/SC also `pnpm test:server`
against your own throwaway database; contracts `pnpm check` and `pnpm gen:check`; app `pnpm check`; appliance per its
CLAUDE.md), all green; commit; report to the lead in at most 300 words: commits, what's done, what's left, decisions you
added (OA-S…), anything another stream must know.

## Lead: merge and ship (not for streams)

Merge streams into `one-agent` per repo → release contracts 0.123.0 (tag, `dist-release`), vendor into Whombat and the
app → app 0.125.0 (tag, APK on DEV downloads) vendored into Whombat → Whombat `one-agent` → `main` → appliance pins →
`dev/candidate --minor` → DEV fresh start (OA-21): `dev/up --reset`, `dev/devbox rebuild` + claim + John invited as owner,
whombat-dev on a new database, skills import, servers enrolled again → live check in a real thread.
