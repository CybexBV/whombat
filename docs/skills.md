# Skills

A **skill** is a short, written way of doing one kind of task (reading mail with Himalaya, working in Notion, writing a
PDF) that the agent reads when a task matches it. The skills are Hermes Agent's: Whombat adds one of its own,
`whombat:settings`, which teaches the agent to change Whombat's settings. Decisions: `docs/decisions/hermes-skills.md`,
with `one-person.md` (one folder, nothing shared) and `assistant-settings.md` (`whombat:settings`).

## What the agent has

One list, in one folder, `$WHOMBAT_HERMES_ROOT/skills`:

- **Hermes's built-ins**, kept by Hermes's own sync at each start and after a restore. A built-in you changed is kept; one
  you removed stays removed until you restore it.
- **Added by you** from Hermes's hub.
- **Learned by** the agent while it works with you.

A skill is a folder (`SKILL.md` and its files) in Hermes's format; what it needs (keys, commands, files) is what its front
matter says, shown as “Needs NOTION_API_KEY”. A few built-ins that can't work on a Whombat start off (another agent's
command line, a desktop, Hermes's own Google sign-in); you can switch them on.

## Settings → Advanced → Skills

The list is grouped by Hermes's categories, then Added by you and Learned by the agent; Off and Removed fold at the end.
You can edit a skill (Hermes's scan checks the change), switch it off, remove it, and compare a changed built-in with
Hermes's and restore it.

**Add skills** searches Hermes's hub: Hermes's optional skills, its trusted GitHub repositories (openai, anthropics,
huggingface, NVIDIA) and skills.sh, never ClawHub or a link. A preview shows the skill, what it needs and what Hermes's
scan found; Hermes's install policy decides whether it can be added (a community skill only when nothing risky is
found; there is no override). Settings checks added skills for updates at most once an hour. A skill of your own comes in
Hermes's way: ask the agent to learn it.

## Backups and storage

A backup file carries the skills folder with its bookkeeping (what is off or removed), and a restore runs Hermes's sync
again.

| setting | default | what |
|---|---|---|
| `WHOMBAT_HERMES_ROOT` | `$WHOMBAT_HOME/hermes` | the agent's Hermes home; `skills/` is the list, `skills/.whombat/skills.json` what is off |
| `WHOMBAT_RUNNER_STATE` | `$WHOMBAT_HOME/runner` | `hermes-skills/`, where Hermes's skills steps run (the hub's quarantine and caches) |
