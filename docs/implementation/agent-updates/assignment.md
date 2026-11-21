# Server agents keep themselves up to date — build brief (2026-10-20)

Decisions: `docs/decisions/agent-updates.md` (AU-01…AU-10). **Read it first**, then §1, §2 and your stream's part of
§3. The wire shapes in §2 are what every stream builds against; contracts 0.99.0 makes them real.

| Stream | Repo | Worktree | Branch (from) | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-au` | `au` (main) | CT-510…CT-529, 0.99.0 |
| H hosts | the hosts service | `~/Code/.wt/hosts-au` | `au` (main) | HS-140…HS-169 |
| A appliance | the appliance | `~/Code/.wt/appliance-au` | `au` (main) | NX-157…NX-169 |
| S server | Whombat | `~/Code/.wt/whombat-au-server` | `au-server` (`au`) | AU-S01… |
| U web + phone | whombat-app | `~/Code/.wt/app-au-ui` | `au-ui` (`au`) | AP-2980…AP-3019 |

Integration branches `au` in Whombat (`~/Code/.wt/whombat-au`) and whombat-app (`~/Code/.wt/app-au`) are the lead's.
C, H and A commit straight to their `au`, which the lead merges into main.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `agent: …`, `hub: …`, `nix: …`,
  `server: …`, `web: …`, `mobile: …`, `client: …`), every message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main` or another stream's
  branch, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`,
  `~/Code/whombat-hosts`, `~/Code/whombat-appliance`): other sessions work there. The lead merges, vendors and ships.
- **Contracts 0.99.0 arrives on `au`** (Whombat and app). S and U start before it lands with what doesn't need the new
  types; when the lead says it is vendored, `git merge au`. Need a contract change? Don't edit vendored tarballs:
  message the lead with the exact additive change.
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check`
  (H: `go vet ./... && go test ./...`; A: the `nix build`s named in §3), plus `pnpm test:server` once (S). Run single
  test files while you work. No VM gates, no CI waits. Own ports (S 4496, U 4498/5203) and throwaway databases; the
  shared `docker compose` (Postgres :55432, Mailpit) is never stopped or reset. `/tmp` runs out of inodes:
  `TMPDIR=~/.cache/wb-tmp`. Temporary containers or VMs only through `/usr/local/bin/agent-resource` (read
  `/home/me/Code/dashboard/docs/agent-resources.md` first; `agent-resource run --task … --ttl 2h -- …`), and release
  what you lease.
- **Android emulator** (U): the AVD `whombat-mobile` is shared; run your own read-only instance on port 5616
  (`emulator -avd whombat-mobile -port 5616 -read-only -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`)
  and `adb -s emulator-5616 emu kill` when done. See `apps/mobile/README.md`.
- **Never touch John's real servers, services or DEV box** from tests or scripts (his Proxmox nodes, The Titan's
  workloads, his DEV Whombat, the frozen `rackoon` container), never push an agent or run an installer anywhere real.
  The lead does the real ones after the merge.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic (version order, who is eligible and why not, the round's
  choices, the words picked by state, the manifest check); fakes in process. A new `*.int.test.ts` needs a reason to
  need Postgres. Check facts (ids, codes, a key phrase), never long literal text. Wait on events or inject short
  timeouts and clocks, never sleep.
- **Copy**: plain, short English a non-developer understands (`docs/decisions/concise-replies.md`), curly quotes
  (’ “ ”), `·`, `…`. AU-08's words are the words. No ids, paths, commands or version strings in visible words except
  where a person must act (the install command) or the card already shows the version.
- **Tokens only** for UI colours/fonts/radii; match the surrounding code's style and comment density.
- Record your own decisions in your stream's file (H: `hosts/docs/decisions/hosts.md` HS-140…; A: appliance
  `docs/decisions/` where NX lives; S: Whombat `docs/decisions/agent-updates-server.md`; U: whombat-app
  `docs/decisions/agent-updates-app.md`; C: the contracts repo's notes as it does them).
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, what the lead must check live). Don't wait for anything after that.

## 2. Wire shapes

### Agent and hub (the hosts service)

Today: `internal/agent/update.go` (self-update), `internal/hub/api_remote.go` (`agentManifest`, `updateInfoFor`,
`updateOne`, `apiUpdateAgents`, `setRollout` → bus event `agent.update`), `GET /api/v1/agents` (`api_admin.go`, the
`update` object per server), `store.GetMeta/SetMeta`.

- **Agent: never older.** `UpdateRequest` with a version older than the running one is refused, code
  `older_version` (versions are `0.0.0-<UTC YYYYMMDDHHMMSS>.<shortrev>` from the appliance, Rackoon's semver before;
  order by the timestamp part when both have one, else semver; unknown order refuses). Same version stays
  `same_version`.
- **Setting** (meta, default on): `GET /api/v1/agents/settings` → `{"auto_update": bool, "halted_version": string|null}`
  (admin); `PATCH /api/v1/agents/settings` `{"auto_update": bool}` → the same (admin, audited
  `agent.settings_changed`). `halted_version` is AU-05's stop; Update now on any server clears it.
- **The automatic round** (AU-03…AU-05): runs at start (after a 2-minute grace for agents to reconnect after a reboot),
  60 s after an older agent connects, and every 15 minutes; inject the clock and intervals for tests. It picks servers
  whose update is available (`updateInfoFor`), whose agent is older than the build, not failed for this version, not
  halted, not busy; then the existing `updateOne`, one at a time, sharing the rollout's `running` flag with the manual
  route (a manual rollout running means the round waits). **Busy:** the report's `system.package_task` set, a console
  or shell session open on that server, or a running task in the agent's own session on a server without systemd.
  **Failed:** `updateOne` errored → the server is failed for that version (kept in meta across restarts); when the
  error is that the agent didn't come back (rolled back), `halted_version` = that version and the round stops.
- **`update` object in `GET /api/v1/agents`** gains (all additive): `reason_code` (`no_build`, `not_connected`,
  `up_to_date`, `no_key`, `other_key`, `turned_off`, `newer_running`), `auto` (the round would take this server),
  `state` also `waiting` (busy, with `waiting_for`: `packages` | `console` | `task`) and `halted`, `failed_version`,
  `updated_at` (last successful update, RFC 3339), `can_install` (AU-07: `no_key`/`other_key`, connected, and
  `host_shell` allowed by both the hub's switch and the agent's policy). The English `reason` stays for the old UI.
- **`POST /api/v1/agents/update`** `{"servers": [id]}` (admin): as today for agents that can take a signed update, and
  it clears that server's failed mark and the halt. For a server with `can_install` it does **the last install**
  (AU-07): through the existing exec path as root, a command that starts the agent's update-mode install (the install
  command without enrollment, as `updateCommand` in whombat-app `packages/client/src/hosts/system.ts` builds it; root
  needs no sudo) **detached** from the exec session — `systemd-run --unit=whombat-agent-reinstall-<n> --collect …` on
  systemd, `setsid nohup … &` elsewhere (Unraid) — so the agent's own restart doesn't kill it; then it waits (as
  `updateOne` does) for the agent to come back with the build's version and key. It must work against **old agents**
  (`5394c53`: their exec runs `systemd-run --pipe --wait`), so check the exec semantics of that commit. Neither
  possible → 409 `needs_install` with the reason. Headless: check whether `requireReauth` applies to the service
  token (Whombat already re-authenticates owners its own way); don't make the Whombat path fail on it.
- **Bus event `agent.update`** `{server, state, message}` gains states `waiting`, `updated` (with `from`, `to`) and
  `halted`; `""` still clears. Audit `agent.updated` records `by: auto|<user>`.
- **The simulator** (`rackoon-sim`) / fake fleet: agents with an older version and a key, one without a key, so the
  round and the last install can be seen in a dev setup.
- Docs: `docs/AGENT-PROTOCOL.md` (older_version), `docs/WHOMBAT.md` / `docs/REST-API.md` (the routes and fields).

### Appliance (the appliance)

- **Key** (AU-01): a raw Ed25519 seed at `~/.config/whombat/agent-signing-dev.key` (0600) on The Titan, created with
  the hosts service's `cmd/rackoon-sign` (`RACKOON_SIGNING_KEY=<path> go run ./cmd/rackoon-sign pubkey` creates it on first
  use). Its public half (base64) is committed as `nix/packages/hosts/agent-update-key.pub`. Never commit the seed.
- **Package** (AU-02): split `nix/packages/hosts` so the agents build in their own derivation (exposed, e.g.
  `.#whombat-hosts-agents`), with `-X rackoon/internal/agent.UpdatePublicKey=<pub>` in their ldflags; `whombat-hosts`
  takes those agents plus the committed `nix/packages/hosts/agent-manifest.json` (`rackoon-sign manifest` format:
  version, key fingerprint, per file arch/size/sha256/sig) and installs it as `share/whombat-hosts/agent/manifest.json`
  only after checking in the build that its version is the agents' version, its key is the committed key's
  fingerprint, and every sha256 and size matches and every signature verifies (a small Go or openssl check in the
  build). A mismatch fails the build with “run dev/sign-agents”.
- **`dev/sign-agents`**: builds `.#whombat-hosts-agents`, signs both files with the key, writes the manifest; and
  `dev/candidate --hosts <rev>` runs it after its vendorHash step (harness `src/dev/candidate.ts`), so a candidate
  always ships signed agents. The DEV image's `checks` keep passing; add a check that the manifest matches.
- Docs: NX rows, `docs/runbooks/dev-instance.md` (the key, what to do if it's lost: agents need their install command
  once more), the package's header comment.

### Contracts 0.99.0 (whombat-contracts)

- `HostServerSettings.agent.update` gains (optional, older hubs): `reasonCode` (the seven codes), `auto: boolean`,
  `state` enum adds `waiting` and `halted`, `waitingFor` (`packages` | `console` | `task`), `failedVersion`,
  `updatedAt` (Timestamp), `canInstall: boolean`.
- `HostAgentSettings {autoUpdate: boolean, halted: boolean}` and endpoints (owners): `hosts.agentSettings` GET
  `/burrows/:burrow/hosts/agents/settings`; `hosts.updateAgentSettings` PATCH the same path, body `{autoUpdate}`;
  `hosts.updateAgent` POST `/burrows/:burrow/hosts/servers/:serverId/agent/update` → `{state: 'updating' |
  'installing'}` (installing = the last install, AU-07). Their operation safety as the repo classifies others (a change
  outside the database, not idempotent, for `hosts.updateAgent`).
- Runtime feature `hosts.agent_updates` (since 0.99.0) in `RUNTIME_FEATURES`. Bump `SESSION_API_LEVEL` only if
  `docs/publishing.md` step 1 says these need it.

### Whombat server

- `toHostServerSettings` maps the new fields; the three endpoints call the hub (`agents/settings`, `agents/update`)
  through the commit pipeline as other hosts changes do (`act`, refusals in words: `needs_install`,
  `update_running` → “Another update is already running. Try again in a few minutes.”).
- Done recently: “Updated the agent on {server}” when the hub says `updated` (automatic or pressed; signed by Whombat
  for the automatic ones). No message in any conversation.
- Worth a look (the hosts hints/sources): an agent that failed or is halted (“The agent on {server} couldn’t be
  updated, so it went back to the version it had.” → Try again), and one that needs its last install (“{server}’s
  agent needs one more install, then it updates itself.” → Update the agent, or the System tab's install command).
  The hub's `agent.outdated` hint must not say the same thing twice.
- The feature advertised when the hosts service is there; the fake hosts service (`hosts/testing/`) learns the setting,
  the round's states and the last install so the dev world shows them.

## 3. Streams

**C — contracts.** §2 contracts with tests as the repo does them; then bump to 0.99.0, tag `contracts-v0.99.0` on
`au` and `pnpm release` → `dist-release/0.99.0/` (provisional: the lead may ask for a re-release before main; a
re-release of the same version means removing that dist dir). Report the dist path. Then stop.

**H — hosts.** §2 agent and hub, unit-tested (version order, eligibility and reason codes, the round with a fake clock
and fake connections: busy, failed, halted, manual clears, one at a time; the last-install command line per install
kind). **A real test** of the update path: in a disposable Debian 12 system container leased through `agent-resource`,
a local headless hub with a signed build (a throwaway key in your worktree's temp dir, never the real one) and an
agent one version older with that key: the round updates it, it comes back on the new version; then a keyless older
agent (built like `5394c53`, without a key) gets the last install through exec and comes back keyed. Release the lease.

**A — appliance.** §2 appliance. Create the DEV key on The Titan (that file is the one real thing you may create), the
split package, the manifest check, `dev/sign-agents`, the candidate step. Prove it with `nix build .#whombat-hosts`
on the current pin after signing (the hub's `GET /agents` would then say available; you can check the manifest with
`rackoon-sign verify`). Don't run `dev/candidate` itself (it ships to John's box; the lead runs it).

**S — server.** §2 Whombat server. Start with the mapping, words and fake against the hub shapes, merge `au` when
contracts are vendored. Int tests only where Postgres matters.

**U — web + phone.** AU-06, AU-08, AU-09: the System tab's Agent card Updates row with its buttons
(`apps/web/src/features/things/tabs/SystemTab.tsx`; reuse `UpdateFirst`'s install-command row), the switch in
This Whombat → About → UPDATES, the phone's server screen row and its Settings switch, the words shared in
`packages/client/src/hosts/`, the dev fixtures. Visual check on the web (both themes, 1440×900) and on the emulator
(light and dark).
