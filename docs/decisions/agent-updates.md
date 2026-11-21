# Workstream: server agents keep themselves up to date (2026-10-20)

John, 2026-10-20 (main checkout), after Install updates on pve-01 failed because its agent was too old: “I want the
agents to automatically update if there is a new version, how would you build this?”. Proposed in the thread (signed
agents, the hosts service rolls them out, one switch, one last manual install), John: “I agree with your picks,
implement this fully.”

What was there: the hosts service already has signed agent self-update (`update` stream: Ed25519 signature checked against
a key built into the agent, install in place on systemd/OpenRC/SysV/Unraid, roll back when the new version doesn't
connect within 5 minutes or crash-loops) and a staged rollout (`POST /api/v1/agents/update`, one server at a time,
stops at the first failure). Nothing used it: the appliance builds the agents unsigned (no key, no `manifest.json`,
NX-152's follow-up), so the hub says “no signed agent build”, and Whombat never calls the rollout. John's five agents
(2026-10-20) run `0.0.0-20261018094703.5394c53` without an update key.

Numbering: AU-01… here; hosts HS-140…; contracts CT-510… (0.99.0); server AU-S01… (`agent-updates-server.md`);
app AP-2980… (`agent-updates-app.md`); appliance NX-157…, candidate IN-318.

## Decided

- **AU-01 Signed agents, a Whombat key.** The agents are signed with a Whombat agent-signing key held by the release
  side on The Titan, never on a box: the public half is built into every agent, the box only relays the signed files.
  A compromised box can then push only genuine Whombat agents, not any program, to servers that only let it watch.
  *Why:* the hub can push an agent to Watch only servers; a key on the box would make it root everywhere. Development
  and production keys are distinct (MA-14); the hosts service runs on DEV Whombats only today (`whombat.hosts is for
  the DEV Whombat`), so this ships the DEV key, and a production key is set up when hosts reaches production.
- **AU-02 The signatures are committed, the build checks them.** Signing happens when a candidate pins a new
  the hosts service (`dev/candidate --hosts`): the agents are built on their own (reproducible), signed, and the manifest is
  committed beside the package; the package refuses a manifest that doesn't match its agents. *Why:* Nix builds are
  pure (no key inside), prod and DEV images get the same verifiable bytes, and a stale signature fails the build
  instead of switching updates off quietly.
- **AU-03 The hosts service updates agents by itself.** When it starts with a newer agent build (after a box update),
  when an older agent connects, and every 15 minutes for whatever waited: one server at a time, through the existing
  rollout (wait for the agent to come back on the new version, its own roll back). Never to an older version: the agent
  refuses a downgrade too. *Why:* an agent restart takes seconds and touches neither the server nor its guests, so
  “right away” beats a night window (John's pick).
- **AU-04 Not while it's busy.** A server installing updates, with a console or shell open, or running a task in the
  agent's own session (servers without systemd) waits; it is tried again at the next round.
- **AU-05 Failures stop, they don't loop.** A server whose update failed is not tried again for that version until a
  person presses Try again (or a newer version comes). When a new version didn't come back on a server (it rolled
  back), automatic updates to that version stop on every server: the build may be bad. *Why:* the agent's own roll back
  keeps each server safe; this keeps a bad build from going round all of them.
- **AU-06 One switch: “Keep server agents up to date”**, on by default, kept by the hosts service, owners change it on
  Settings → This Whombat → About, under UPDATES. Off, nothing updates by itself; Update now still works per server. A
  server's own owner can still refuse updates on the server (`[update] allow = false` in agent.toml); Whombat shows it.
- **AU-07 The one last install, as one click where Whombat may.** An agent without the key (every agent installed
  before this) can't take a signed update. Where Whombat may run commands as root on that server (Run commands on both
  sides), **Update the agent** does that last install for the owner: the hosts service runs the agent's install command
  in update mode there, detached so the agent's restart doesn't cut it off, and waits for the agent to come back with
  the key. Elsewhere the System tab shows the install command to run once (as today). Never automatic: a person
  presses it. *Why:* four of John's five servers allow it; nobody should have to SSH into each.
- **AU-08 What people see.** The System tab's Agent card gets an Updates row: “Kept up to date” · “Updating to the new
  version…” · “Waits until {server} has finished installing updates” · “Couldn’t update: it went back to the version it
  had. [Try again]” · “Needs one more install, then it updates itself. [Update the agent]” or the install command ·
  “Updates are turned off on {server} itself.” · “Automatic updates are off. [Update now]”. A finished update is one
  line in Done recently (“Updated the agent on pve-01”); a failure and an agent that needs its last install are in
  Worth a look with their button. The phone shows the same row on the server screen and the switch in Settings.
- **AU-09 Feature `hosts.agent_updates`.** Clients show the row, the switch and the buttons only when the runtime has
  it.

## Not now

- **AU-10** *The production agent key is superseded by appliance NX-523 (one environment, `one-environment.md`): today's agent-signing key signs agents for every box, and production images carry the hosts service.* Still not now: choosing a night window, updating a
  cluster's agents in an order, pinning a server to an older agent.
