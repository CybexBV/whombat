# One person per Whombat, no computer — the brief

Spec: `docs/decisions/one-person.md` (OP-01…OP-19). Read it first, then `inventory.md` beside this brief, `CLAUDE.md`,
`ARCHITECTURE.md`, and for the commands, the container engine and the network:
`~/.cache/wb-tmp/research/2026-10-25-no-computer/notes.md`. The product is unreleased: **delete, don't deprecate** — no
compatibility shims, no old clients, no flags kept for old phones (HE-27). Lead: session whombat-85.

Starts when hermes-native.md is on Whombat main and its DEV candidate is out (OP-15): every integration branch is made
from the mains of that moment.

## Numbers (claimed)

- contracts **3.0.0**, session major **4**, CT-1500…CT-1599; control-contracts its next major (from 2.1.0)
- whombat-app **3.0.0**, AP-5650…AP-5799 (client 5650…5669, web 5670…5729, phone 5730…5799)
- Whombat: details OP-S01… under “Details” in `docs/decisions/one-person.md` on your branch (S1 OP-S01…S39, S2
  OP-S40…S79, R OP-S80…S129, D OP-S130…S149); migrations while you work: S1 **0006**, S2 **0007**; D folds them into one
  `0006_one_person` (a contract migration with a checkpoint, MD-06)
- appliance IN-440…IN-469, NX-455…NX-489, console CG-345…CG-359 · control CL-140…CL-159, BL-40…BL-49, migration
  0019 · relay RL-35…RL-39

## Repositories, branches, worktrees

Integration branches `one-person` (only the lead merges into them): contracts `~/Code/.wt/contracts-op` · Whombat
`~/Code/.wt/whombat-op` · whombat-app `~/Code/.wt/app-op` · appliance `~/Code/.wt/appliance-op` · control
`~/Code/.wt/api-op`.

Streams: each its own worktree and branch off `one-person`
(`git -C <repo> worktree add -b op-<x> ~/Code/.wt/<repo>-op-<x> one-person`); small commits (`server: …`,
imperative, ending with the Co-Authored-By line of CLAUDE.md); never push, never merge into `main` or `one-person`.
When the lead says “merge one-person”, `git merge one-person` into your branch.

| Stream | Repo | Owns |
|---|---|---|
| C | contracts | the contracts surface of the inventory: members, invites, re-enrolment, admins, roles, presence, credential sources, skill sharing, connection scopes, Vault privacy, per-person spend and usage, backup people, licence `members` (vectors re-signed), the computer surface (`computers.*`, `HostInfo.computers`, host metrics, desk part, activity rows, Vault computer copy; the command guard stays), HN-A02's `clientAdapters`; new: the agent's services (OP-19: list and stop, ports 20000–20099) and container status where the app shows it; control-contracts' org roles, invitations and plan limits. Provisional dist in `dist-release/3.0.0`, marker `~/.cache/wb-tmp/one-person/C-READY`. |
| S1 people | Whombat | `apps/server`: invites and join links, onboarding's step 4, appliance invites, re-enrolment, admins, roles and their gates, offboarding, credential owner and organisation keys (OP-09), licence member count, screen sign-in's email, seed and test world with one person. |
| S2 privacy | Whombat | `apps/server`: whom the turn is for (the person, or an outsiders' turn, OP-17), Vault privacy, personal vs shared connections, per-viewer frames and reads, rooms, approvals and “tell the owners”, spend and usage, backups' people, desk owners, skill sharing, the computer's server side (`computers/**`, `computer/**` keys and report; the guard and approvals stay), the services' ops (OP-19). |
| R runtime | Whombat | `apps/runner`, `packages/agent-runtime`, `packages/hermes-whombat`, `apps/computerd` (deleted), `packages/computer` (what the guard needs stays): one Hermes profile in Hermes's layout and one pod (OP-08), Hermes's local terminal with the per-command wrapper (OP-07: namespaces, proxy with the computer's rules, the Hermes home and sockets hidden, Vault keys on tmpfs, cgroup), Hermes's file tools blocked in its home, gh and the git relay sockets, Files, the work folder, Chromium in the wrapper and the assessor's site-limited browser, `DOCKER_HOST` and the services' runtime side (OP-16, OP-19), the prompt (one person, tools on the image, no `sudo apt`), outsiders' turns in their own profile (OP-17), development's stand-ins (`pnpm dev` runs the same wrapper; Podman when the host has it, else the services say they aren't available). |
| W web | whombat-app | `packages/client/**`, `apps/web/**` after C is vendored on `app-op`: Members, invites, join, re-enrol, owners, org invitations, onboarding's step 4, sign-in sharing, skills sharing, connection scopes, everyone's usage, presence, the Computer tab → the services list (OP-19), owner checks, copy, fixtures (one person), baselines. |
| M phone | whombat-app | `apps/mobile/**`, after W's client part is in `one-person`; the same on Android, 44 px targets. |
| N appliance | appliance | computers out (`computers.nix`, `computerslan/`, VM tests and helpers, qgroup 1/101, units, ids), a cleanup unit for `/persist/incus*` on existing boxes, rootless Podman with Docker's API as its own user (socket for the runner's commands, storage and quota on /persist, nftables for the commands' proxy and the containers mirroring `computers_out`, published 20000–20099 private only), the agent toolset package and nix-ld libraries (OP-13; measure LibreOffice and TeX), Hermes's package with what commands now need beside it, backups with one Hermes home and the agent's home (container storage not), host metrics without computers, harness (delete `b5-people`, `b4-reenroll`; rewrite the multi-person parts), dev tooling, docs and runbooks, terms version. |
| A control | control, relay, hosts | orgs with one account, invitations and member limits out, one plan at €49 (OP-18; plan rows, lookup keys, trial plan; no Stripe objects created), migration 0019, operator panel, docs; relay RL-33 to 64; hosts' wording. |
| D data | Whombat | after S1, S2 and R are merged: `0006_one_person` (OP-10), merging `_shared`'s memory and learned skills into the person's profile, `-mine` handles renamed, a dry run against a copy of Home's database shape; `pnpm test:server` whole and green. |

A file outside your column: keep the change to the lines your decision needs and name it in your report, or ask the
lead.

## Rules for every stream

- Node 24 and TMPDIR: `export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`,
  `export TMPDIR=/home/me/.cache/wb-tmp`. Postgres :55432, your own throwaway databases only; never stop or reset
  shared containers. VMs and containers only through `agent-resource` (`/home/me/Code/dashboard/docs/agent-resources.md`).
- Search only inside your worktrees and the repositories named here; never `find`/`grep` over `/` or `$HOME`.
- Tests: delete the tests of what is deleted; for what changes, test facts (ids, names, counts, codes), not long
  literal text (`docs/decisions/test-speed.md`).
- Words people see follow `docs/decisions/concise-replies.md`: the agent by its name, “you”, plain English; no
  members, owners, team, computer.
- Don't touch production, Home, the dev stack or DEV control: the lead ships.

## Stop points (the lead asks John)

Anything in production (app.whombat.com, production control, Stripe live mode); creating Stripe prices; removing
another person's data on Home; publishing the community edition or the website; anything that would let a command reach
a sign-in, the policy or Hermes's sockets (OP-07).

## Finishing a stream

`pnpm format`, then your repo's check (Whombat: `TMPDIR=~/.cache/wb-tmp pnpm check`; S1, S2, R, D also
`pnpm test:server` against your own throwaway database; contracts `pnpm check` and `pnpm gen:check`; app `pnpm check`;
appliance and api per their CLAUDE.md), all green; commit; report to the lead in at most 300 words: commits, what's
done, what's left, decisions you added (OP-S…), anything another stream must know.

## Shipping (lead)

Contracts 3.0.0 tagged (byte-identical to the provisional dist), whombat-app 3.0.0 tagged with its APK on DEV downloads,
the mains of Whombat, appliance, api, relay and hosts, then `~/Code/whombat-appliance/dev/candidate --host --api …`
(control, the manager and the runtime move together), Home checked through `dev/support` after a checkpoint.

## Interfaces between streams (lead, 2026-10-25)

- **I-1 Tools.** The appliance sets the runner's `WHOMBAT_AGENT_TOOLS` (a Nix store path of OP-13's set; commands get
  its `bin` first on `PATH`) and `WHOMBAT_AGENT_NIX_LD` / `WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH` (given to commands as
  `NIX_LD` / `NIX_LD_LIBRARY_PATH`); `/lib64` is visible read-only to commands. Unset (development): the host's `PATH`.
- **I-2 Container engine.** Rootless Podman with Docker's API as the user `whombat-containers`, socket
  `/run/whombat-containers/podman.sock`, group `whombat-containers` (the runner and the server are members); runner and
  server env `WHOMBAT_CONTAINERS_SOCKET`. Commands get `DOCKER_HOST=unix://…` for the socket bound into their wrapper.
  The server lists and stops the agent's services through it: containers labelled `whombat.service=1` with a published
  port in 20000–20099, at most 5. Unset (development without Podman): services and Docker say they aren't available.
- **I-3 The agent's home.** `/persist/whombat/agent/home` on the appliance (`$WHOMBAT_HOME/agent/home` in development),
  runner env `WHOMBAT_AGENT_HOME`, group-writable for `whombat-containers`; commands see it as `$HOME` at the same path,
  and the work roots at their own paths, so `docker run -v ./src:/app` works. Backed up; container storage is not.
- **I-4 Commands' network.** Commands share one network namespace per pod (a holder, joined per command as the local
  computer backend does with `nsenter -U -n`), never the pod's own (Hermes's sockets live there). Its
  `127.0.0.1:3128` leads to a proxy that applies the computer's rules (`egressRules`: any public TCP but 25, the home
  networks allowed, production servers only through an opening); the proxy runs in a small daemon under its own uid
  (computerd's, renamed and cut down to this by R2), socket `/run/whombat-agent-net/proxy.sock`. The appliance gives
  that uid, and `whombat-containers`, the `computers_out` rules. The agent's Chromium runs in the commands' namespace
  (it opens what commands serve on localhost); Hermes reaches its DevTools through a bridged socket.
- **I-5 Ports.** 20000–20099 open from private sources only (NX-138's rule) for `whombat-containers`' listeners.
