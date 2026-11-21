# All skills, used like OpenClaw and Hermes — plan

Status: proposal (2026-10-18), nothing built. Research: `research/openclaw.md` (OpenClaw 2026.10.4, commit 14a5324),
`research/hermes.md` (Hermes Agent commit 22063fc0). Whombat today: see “Where Whombat is” below.

## What OpenClaw and Hermes do

Both agents keep **every installed skill available** and pay for that with a **compact index**, not the bodies:

| | OpenClaw | Hermes | Whombat today |
|---|---|---|---|
| What the model sees each turn | `<available_skills>` name + description + path, terse rules | index grouped by category, description **≤ 60 chars** | CLI-native listing (Claude plugin / Codex extra roots), name + description (≤ 300 chars) |
| Body | read on demand (`read` / `skills_read`) | `skill_view(name)`, files on demand | CLI `Skill` tool / file read — already on demand |
| Which skills | all eligible, minus per-skill `enabled:false`, optional per-agent allowlist | all installed, minus `skills.disabled` | **only attached packs**: the assistant gets 1 pack (16 of 132 skills) |
| Hidden when it can’t work | yes: missing binary / env / config / OS | yes: platform, missing toolset, fallback-only | no: listed with “needs the browser key” |
| Budget | 18k chars / 150 skills, then shorter descriptions → names only, plus `skills_search` | none (descriptions capped at 60) | none (Claude Code itself drops descriptions past 1% of context, least-invoked first — meaningless with a fresh CLI home every turn) |
| Prompt cache | list snapshotted per session, refresh below the cache boundary | index built once per session; changes announced in the next user message | content-hashed plugin folder (AE-07) |
| Learning | `skill_workshop`: create / patch / archive, applied at once with Undo (10 versions); background review after 10 turns | `skill_manage`: create / **patch** / files; background review after 15 tool calls, “prefer patching a skill you loaded”; curator archives unused (14/30 days) | `propose_skill`: create or replace an own skill, learned at once with Remove (AC-52); no patching, no review, no curator |
| Improving shipped skills | Workshop copy shadows the bundled one | patches bundled skills in place (John’s `proxmox`: 196 uses, 89 patches) | impossible (shipped packs are immutable) |
| Sources | bundled 49, ClawHub, `skills-sh:`, git, local | bundled 58 + 153 optional, skills.sh, GitHub taps, ClawHub, LobeHub, well-known | 21 packs / 132 skills; upload needs `whombat-pack.json`; single-skill link import (agent settings only) |
| Security | VirusTotal + LLM judge on ClawHub (after ClawHavoc: 341+ malicious skills), install policy hook | 136-pattern scanner, quarantine, trust levels, lock file | scanner (4 categories) on every pack and proposal |
| UI | Plugins → Skills: All / Ready / Needs setup / Disabled, status dot, missing requirements, install, API key field | dashboard list / toggle / edit / create / hub | `/skills` in the sidebar (assistant shell), Settings tab hidden there |

What makes them feel capable is not the loading trick (Whombat has it) but: **everything is on**, **what can’t work
is hidden**, **the index stays small**, and **the agent fixes the skill it just used**.

## Where Whombat is

- Loading is already right: skills reach Claude Code as a read-only local plugin and Codex as extra skill roots; the
  body loads only when the model opens it (`packages/agent-runtime/src/claude/skills.ts`, `codex/skills.ts`,
  `apps/runner/src/skills.ts` `materializeSkills`). Usage is counted (`apps/server/src/skills/uses.ts`).
- Availability is the gap: `assistantGivenPacks` attaches only Assistant productivity (LM-P02); the other 116 shipped
  skills wait for a person to add a pack.
- Inventory on John’s machines (2026-10-18): Whombat 132 shipped; Hermes 166 installed, of which ~95 are John’s own
  or learned (cybex, cybex-pulse, home-assistant-live-investigation 284 uses, proxmox, unifi-network,
  web-application-maintenance, linux-storage-management, tailscale, cloudflare, menerga, hydronic-climate-control,
  hetzner-cloud, transip …); OpenClaw 68 bundled. ~312 distinct names; 43 Whombat names also exist in Hermes.
- Index cost if we simply switched all 132 shipped skills on: ~34k chars ≈ 8.5k tokens per call (descriptions avg
  201 chars). Capped at 60 chars: ~15.6k chars ≈ 3.9k tokens. With relevance gating (below) far fewer skills qualify.

## Decisions proposed (SK-…)

### Part 1 — every skill available, small index (the core)

- **SK-01 The library is what the assistant knows.** Every installed skill is available to the assistant unless it
  is switched off. Packs stop being an access unit and become a *source/group* (Homelab, Documents, Learned by
  Dusty, From Hermes). Migration: attach every installed pack to the assistant; `pack_skills_off` stays the off
  switch; “Add to Dusty” disappears. (Crew-shell agents keep per-agent attachments; nothing changes for them.)
- **SK-02 Hide what can’t work here.** Optional front matter `metadata.whombat.requires`:
  `connections: [notion]`, `servers: [proxmox]` (a server/platform kind), `commands: [ffmpeg]`, `keys: [browser]`.
  A missing connection or server kind **hides** the skill (it’s noise); a missing key keeps it listed with the
  existing “needs the browser key” note (one tap away); a missing command is fine (the computer can install it).
  Annotate the 132 shipped skills once (most are generic; ~40 are tied to a service). On import, map OpenClaw
  `metadata.openclaw.requires.bins/env/os` and Hermes `platforms` / `requires_toolsets` onto this.
  BP-D20 changes from “refuse any key but name/description” to “keep name, description and `metadata`; drop the rest
  in the materialized copy”.
- **SK-03 Whombat budgets the index itself, the same for Claude and Codex.** The runner already rewrites each
  SKILL.md’s front matter, so it decides what the CLI lists:
  1. full description (cut at 160 chars) for pinned, used in the last 30 days, learned, and skills tied to a
     connected thing;
  2. 60-char description for the rest;
  3. names only past the budget — **10k chars (~2.5k tokens)**, configurable per box;
  plus a **`find_skill`** tool (keyword search over name, description and the first lines of the body; returns
  name, description and the path to read) for anything not described. Same ladder as OpenClaw, same cap idea as
  Hermes, and it stops Claude Code’s own 1%-of-context trimming from picking arbitrary skills.
- **SK-04 Keep the prompt cache.** The skill set is frozen per conversation (content hash, AE-07). A skill learned
  or changed mid-conversation is announced once in the next turn (“You can now also use: menerga-heat-pump”), not
  re-listed; the full rebuild happens on a new conversation or compaction (Hermes’s approach).
- **SK-05 Prompt words.** Keep RA-16’s “look at the skills first; when one matches even partly, use it” and add
  Hermes’s split: procedures, pitfalls and the person’s preferences for a task go into the skill you used; only
  facts that apply to every conversation go into memory.

### Part 2 — Dusty improves its skills (the Hermes loop)

- **SK-06 One skill tool instead of `propose_skill`:** `skill_write` with `create`, `patch` (old → new text),
  `add_file`, `remove_file`, `rest`. Applied at once, scanned (dangerous → refused with the reason), each change a new
  immutable version (pack versions already are) with **Undo**. A new skill keeps today’s “I learned a skill” card; a
  patch posts nothing in the chat (concise-replies) and shows as “Changed today” on the skill.
- **SK-07 Improving a shipped or imported skill makes Dusty’s version.** A patch to a skill Dusty didn’t write
  creates an overlay that shadows it by name (precedence: Dusty’s > imported > shipped, like OpenClaw’s workspace >
  bundled). The skill shows “Dusty’s version · Compare with the original · Reset to original”. When the shipped
  skill updates, Dusty’s version stays and the row says the original changed, with the diff.
- **SK-08 Background review after long tasks.** After a turn with ≥ 12 tool calls and no skill write, the runner
  starts a short review turn once the reply is delivered: same cached prompt, only the skill tools plus reading, at
  most one change, “prefer patching a skill you loaded; never name a skill after one incident”. Not for automation
  runs. Cost: one short extra turn, only after long tasks.
- **SK-09 Curator.** Learned skills unused for 60 days go to **Resting**: out of the index, still found by
  `find_skill`, back on first use; never deleted; **Pin** keeps one listed. Shipped skills are never rested — the
  ladder in SK-03 already shortens unused ones.

### Part 3 — bring all our skills in

- **SK-10 Import any skill folder.** Settings → Skills → Add skills accepts: a zip/folder of `SKILL.md` folders
  without `whombat-pack.json` (refused today), a Hermes skills folder (categories become groups “From Hermes ·
  smart-home”), an OpenClaw / Claude Code skills folder, a GitHub repo or folder, a skills.sh or ClawHub link (the
  single-skill link import moves here from agent settings). Every file is scanned; a token or password found in a
  skill becomes a Vault entry prompt instead of being stored; known foreign tool names (Hermes `terminal`,
  `skill_view`, `browser_*`, OpenClaw `exec`, `read`) are rewritten to Whombat’s and the original is kept.
- **SK-11 John’s own skills first.** Import his active Hermes skills (state `active`, used at least once; ~30–40),
  skipping archived ones. For the 43 names Whombat also ships, the Hermes copy — patched with his environment —
  becomes Dusty’s version over the shipped one (SK-07), so nothing is lost and Reset still works.
- **SK-12 Finding new skills.** `find_skill` with `online: true` searches skills.sh, ClawHub, Hermes’s official
  optional skills and anthropics/skills when nothing local fits. Trusted sources (Whombat, Hermes official,
  Anthropic) install at once with an “I added …” card and Undo; community skills (ClawHub, skills.sh, GitHub) are
  quarantined, scanned and wait for a person’s tap; dangerous ones are refused. (ClawHub had 341+ malicious skills
  in early 2026; this is why community installs ask.)

### Part 4 — Settings → Skills replaces the sidebar row

- **SK-13** Remove the sidebar’s Skills row; show the existing Settings tab in the assistant shell (today filtered
  out, `SettingsScreen.tsx:156`); `/skills` redirects to `/settings?tab=skills` (reverses AP-1261/AP-1795, back to
  AP-882’s reasoning: a library you seldom open belongs in Settings). One UI only.
- **SK-14 The tab**, following less-is-more (AP-1749…1755):
  - one line of help (“Dusty uses a skill when a task matches it.”), a search box, chips **All · Ready · Needs
    setup · Off · Learned**;
  - rows grouped by source (Learned by Dusty first, then From Hermes, Homelab, Documents …): name, one-line
    description, status (Ready / Needs UniFi / Off), “Used 12 times”, a switch; Resting and Off folded at the end;
  - a row opens the skill: rendered SKILL.md, files, history (versions with Compare and Undo), **Edit** (Markdown;
    editing a shipped skill makes your version), Pin, Reset to original;
  - top actions: **Learn a skill** (link / file / thread, today’s Learn this) and **Add skills** (SK-10).
- **SK-15 Phone:** Settings → Skills with search, status and switches; opening a skill shows it read-only (no
  editor on the phone).

## Order

1. Part 4 + SK-01…05 (one release: everything on, gating, budget, `find_skill`, the Settings tab).
2. SK-10/11 (import, then John’s Hermes skills onto his box through the UI).
3. SK-06…09 (write/patch tool, overlays, background review, curator).
4. SK-12 (online search and install).

Touches: contracts (front matter `metadata.whombat.requires`, `find_skill` / `skill_write` tool schemas, import
endpoints, overlay + pin + resting fields), a migration (overlays, pins, resting; attach-all backfill), runner
(index ladder, frozen set, review turn), app (Settings tab, skill page + editor, Add skills), Android (Settings →
Skills), appliance candidate. Verification: index size per turn measured in a real turn (`/context`-style count in
the runner log), a live “fix my UniFi AP” turn on the DEV box that opens the imported skill, and a patch + Undo.
