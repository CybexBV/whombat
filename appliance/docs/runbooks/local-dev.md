# Local integrated environment (W3-INT)

> Commands written `dev/<name>` are the maintainers' (`bin/<name>` in their private whombat-ops). Anyone can run
> the same code: `node harness/src/dev/<name>.ts` (`dev/prune` is `prune-copies.ts`, `dev/devbox` is
> `harness/src/devbox/main.ts`), after `pnpm install --frozen-lockfile` in `harness/`.

One command starts the whole managed product on this machine from the commit that is checked out (the component
list, `manifest/components.json`, with control and the relay at the commits production runs):
cloud control, the relay, a provisioned dev appliance (manager, managed runtime, the commands' network daemon, the
runner with Hermes — the runtime's deterministic scripted Hermes by default), an append-only restic REST server and the
hosted web app. Decisions: `docs/decisions/integration.md`.

## Prerequisites

Node 24, pnpm 12, Go 1.26, Docker, `git`, `restic`, Nix (for PostgreSQL 17 client tools and, with live agents, Hermes),
bubblewrap and `nsenter`, unprivileged user namespaces and a `systemd --user` manager (the runner's managed sandbox and
the commands' wrapper, IN-403). The shared Mailpit at 127.0.0.1:51025 (SMTP) / 58025 (UI, API) must be
running — the harness uses it and never starts or stops it. Use `TMPDIR=~/.cache/wb-tmp` on the shared host (the
wrappers set it).

## Commands

```sh
dev/up                      # start everything from this checkout's commit (the component list; WB_MGD_PINS names another set)
dev/up --live               # every component from its owner's working tree, as it is (never installs into it)
dev/up --live app,runtime   # only those live (app, runtime, control, relay, manager), the rest pinned
dev/up --manager=standin    # the TS dev manager instead of the real whombat-manager (default: real, falls back)
dev/up --without web,runner # skip optional services (restic, backup, manager, hosts, agent-net, runtime, runner, web, embed)
dev/up --reset              # remove all state first (new appliance identity, new databases)
dev/up --lockfile-drift     # pinned mode only: install without --frozen-lockfile when a committed lockfile is broken
dev/status [--json]         # health of each service, the appliance, the runtime's /health, sources
dev/logs [service] [-f]     # control, relay, runtime, runtime-migrate, runner, agent-net, manager, tuf, tuf-refresh, restic, backup, web, embed, postgres
dev/down [--purge]          # stop (purge: also remove the container, its volume and ~/.cache/whombat-mgd/env)
dev/console [--watch|--json] # the dev appliance's console: the claim code, as tty1 shows it on an appliance
node harness/src/dev/restart.ts relay|runtime|runner|agent-net|manager|control|tuf-refresh   # restart one service
```

`dev/up` prints the URLs, the appliance id and fingerprint, the console (the claim code once the runtime has one)
and the claim card path, and whether the commands' network daemon runs (`agent-net`, below).

| Service | Where | Notes |
|---|---|---|
| Postgres | `whombat-mgd-pg`, 127.0.0.1:55490 | own container and volume `whombat-mgd-pg-data`; databases `whombat_control`, `whombat_runtime` |
| control | http://127.0.0.1:4600, operator :4601 | `CONTROL_ENV=local`; keys and tokens from control's `dev-init` in `env/control/` (0600) |
| relay | ws://127.0.0.1:4610/v1/connect, admin :4611 | worker `local-1`, audience `whombat-relay:local`, JWKS from control |
| appliance | `env/appliance/` | made on the box as every image makes it (not registered at control until its Whombat Link starts; `WB_MGD_PROVISION=control` is a box control registered before Link): `identity/` (management.key, content.key, device.json, registration.json, claim.json); the installer's reach choice `env/persist/whombat/reach.json` (Whombat Link; `WB_MGD_REACH=tailscale`, `both` or `none`); persistent layout `env/persist/` (`whombat/{home,workspaces,credentials,hermes,agent/home}`, `secrets/master.key`, `backup/`); console state `env/run/console.json` (the runtime's `WHOMBAT_CONSOLE_FILE`) |
| manager | `env/run/manager.sock` | real `whombat-manager` + dev TUF repo on :4639 (`env/manager/`; its timestamp re-signed every 6 h by `tuf-refresh`, IN-224), or the stand-in; AI clients from the repository's client channel into `WB_MGD_CLIENTS_ROOT` (default: a plain-path link in `$XDG_RUNTIME_DIR` to `env/persist/whombat/clients`, IN-37) |
| runtime | admin socket `env/run/admin.sock`; loopback :4620 (runner and MCP only); direct listener 127.0.0.1:4621 | `WHOMBAT_MODE=managed`, migrated by `whombat migrate --json --env`; the direct listener (Whombat HE-50, IN-419) is the same Noise session as through the relay, `WHOMBAT_DIRECT_PORT` on `WHOMBAT_DIRECT_INTERFACES=loopback` (a box: 4480 on `lan,tailscale0`) |
| agent-net | `env/run/agent-net.sock` | the commands' network daemon (Whombat OP-07, NX-456): the runtime checkout's `apps/agent-net` when it has one (else `skipped`), the proxy with the agent's rules every command's network leads to, `WHOMBAT_AGENT_NET_SERVICE_PORTS` 20000–20099; the runner's `WHOMBAT_AGENT_NET_SOCKET`. No container engine here (`WHOMBAT_CONTAINERS_SOCKET` unset): the runtime says Docker and the agent's services aren't available |
| runner | — | Hermes for every turn in the managed sandbox (IN-403): the runtime's scripted Hermes (deterministic; no provider credentials, no paid calls); `WB_MGD_AGENTS=live`: the image's Hermes with the installed clients, the person's own sign-in (IN-38, below); Hermes's home in `env/persist/whombat/hermes`, the agent's home (`WHOMBAT_AGENT_HOME`) in `env/persist/whombat/agent/home` |
| restic | http://127.0.0.1:4630 | `rest-server --append-only --no-auth` (loopback only) |
| backup | `env/run/backup.sock` | `whombat-backup serve` (appliance `backup/`), destination the rest-server, pg_dump 17 from nixpkgs at the appliance flake's pin (`bin/postgresql-17`), `copy` snapshot driver over `env/persist` (IN-26); the manager's `backupSocket`, the runtime's `WHOMBAT_BACKUP_SOCKET` |
| web | http://localhost:5190 | the hosted app (`VITE_WHOMBAT_TARGET=hosted`, session transport), control URL above |
| embed | http://127.0.0.1:4640 | the Feedback widget's embed tree (the app's `build:embed` for control's URL, `env/embed/dist-embed`), served by `harness/src/dev/embed-server.ts` with its `_headers`; the runtime's `WHOMBAT_EMBED_URL`, control's `CONTROL_EMBED_ORIGINS` (IN-54; app ≥ 0.6.0) |
| Mailpit | http://127.0.0.1:58025 | shared; magic links for control |

Ports are MA-14's; override with `WB_MGD_PG_PORT`, `CONTROL_PORT`, `CONTROL_ADMIN_PORT`, `RELAY_PORT`,
`RELAY_ADMIN_PORT`, `RUNTIME_PORT`, `WB_MGD_DIRECT_PORT`, `WEB_PORT`, `RESTIC_PORT`, `WB_MGD_TUF_PORT`, `EMBED_PORT`, and the
state root with `WB_MGD_HOME`.

## Old per-commit copies

Each pinned commit gets its own clean clone (`src/<id>@<commit12>`, with `node_modules`), Go build (`bin/<id>@<commit12>`)
and runtime fixtures (`fixtures/runtime-<kind>@<commit12>-f<N>`), a few GB per candidate. After it is up, `dev/up` removes
the ones nobody needs. It keeps every copy at a commit `env.json` runs, every copy a running process uses, every copy
used in the last hour and the newest `WB_MGD_KEEP_COPIES` (default 3) per component and directory, counted by last use
(`dev/up` marks each copy it reuses). Everything else in those directories is left alone. `WB_MGD_KEEP_COPIES=all`
turns it off; `dev/prune [--dry-run]` does the same by hand (holding the environment lock).

## One environment per state directory; running several side by side

`dev/up`, `dev/down`, `harness/validate` and `harness/demo` hold `<WB_MGD_HOME>/env.lock` while they run; a second
one refuses and names the holder (a lock whose process died is taken over). To run your own environment next to
another, set all of these (example: the app agent on 4700–4739):

```sh
export WB_MGD_HOME=~/.cache/whombat-mgd-app WB_MGD_PG_CONTAINER=whombat-mgd-pg-app WB_MGD_PG_PORT=55491 \
  CONTROL_PORT=4700 CONTROL_ADMIN_PORT=4701 RELAY_PORT=4710 RELAY_ADMIN_PORT=4711 RUNTIME_PORT=4720 \
  WB_MGD_DIRECT_PORT=4721 WEB_PORT=4790 RESTIC_PORT=4730 WB_MGD_TUF_PORT=4739 EMBED_PORT=4740
dev/up --live app
```

Container names must start with `whombat-mgd-` (the harness refuses to touch anything else).

A public instance behind a tunnel (dev.whombat.com) is the same `dev/up` with `WB_MGD_PUBLIC_*` set:
`docs/runbooks/dev-instance.md`.

## Agents: Hermes and the commands (IN-38, IN-403)

Hermes runs every turn, in the runner's managed sandbox (task cgroups in a `systemd --user` scope of the slice
`whombat_mgd_<hash of WB_MGD_HOME>.slice`, one per environment), and its commands in a wrapper of their own whose network
leads to `agent-net`'s proxy (Whombat OP-07; the agent's computer is gone, OP-04).
Scripted (the default): `WHOMBAT_HERMES_BIN` is the runtime checkout's `scripted-hermes.ts`. A scripted stack's agent
can't answer a person yet: the runner runs a Claude Code or Codex turn only with the CLI installed and on the asker's
own sign-in (IN-404). Live: `WB_MGD_AGENTS=live dev/up` builds the image's Hermes with the running runtime's plugin
(`nix build .#whombat-hermes --override-input whombat …`, `bin/whombat-hermes@<commit>`, log `dev/logs build-hermes`)
and runs agents on the Claude Code the manager installs from the environment's client channel and on ChatGPT through
Hermes's own provider (no client, IN-432). Publish a channel into the environment's
repository first (`WB_CLIENTS_REPO=$WB_MGD_HOME/env/manager/tuf WB_CLIENTS_STATE=<own dir>
release-tools/clients/latest-tested`, `docs/runbooks/client-latest-tested.md`), then check it with
`scenarios/k-live-agents` (it signs nobody in and calls no model). Model calls happen only for people who signed in.
The mode is recorded in `env.json`; switching needs `dev/down` first. `WB_MGD_EGRESS_ALLOW` adds hosts tasks may
reach (comma-separated, e.g. package registries).

Hermes's browser (Whombat HE-42, IN-407) drives a Chromium in the commands' own namespace (Whombat OP-07): on a box
the agent's tools' (NX-464), here the host's own, from the host's `PATH` (no `WHOMBAT_AGENT_TOOLS` in development);
install `chromium` on the host to have it. There is no browser service of the environment's own, and `dev/up`'s
summary has no `browser` line any more. An environment an older harness started had a `browser` or a `computerd`
service: `dev/up` and `dev/down` stop it and remove its files (`env/run/browser.sock`, `env/browser`,
`env/run/computerd.sock`).

## Google (IN-49)

`WB_MGD_GOOGLE=fake dev/up` runs the runtime with `WHOMBAT_GOOGLE=fake`: connecting Google (Settings → Connections,
or the guide in your assistant's DM) completes as you@example.com without Google, through the hosted UI's
`/connect/google` and `connections.finishGoogle` as on a real appliance. Unset (the default) is real Google: you
set up your own OAuth client with the redirect URI `http://localhost:<WEB_PORT>/connect/google`. `real` and
`off` are the other values; switching needs `dev/down` first. `scenarios/m-guides` switches its environment to the
fake by itself and back afterwards.

## The own address (MG-161)

Off unless set, so a reset never spends a label and a Let's Encrypt certificate (Whombat OWA-18):

- `WB_MGD_OWN_ADDRESS` is the environment appliance's manager's `WHOMBAT_OWN_ADDRESS`: `off` (the default),
  `staging`, `on`, or `pebble:<directory URL>` for a test CA. The runtime gets the manager's ACME socket beside its API
  socket (`WHOMBAT_MANAGER_ACME_SOCKET`).
- `WB_MGD_OWN_ADDRESS_ZONE` and `WB_MGD_OWN_ADDRESS_LBL` are control's `OWN_ADDRESS_ZONE` and `OWN_ADDRESS_LBL` (an
  older control ignores them). `lbl` on needs a relay with the door: an older relay refuses every ticket carrying it.
- `WB_MGD_DOOR_LISTEN` (with `WB_MGD_DOOR_ZONE`, default `dev.whombat.app`, and `WB_MGD_DOOR_PROXY_FROM`, the
  forwarder's CIDRs) switches the relay's door on; a relay from before the door gets none, and `dev/up` says so.
- The maintainers' `candidate --relay <rev>` moves the relay the candidate pins and deploys it to production, as `--api`
  does control (IN-835).

## Using it by hand

The dev appliance starts as a box does whose owner chose Whombat Link at the installer (Whombat `whombat-link.md`
LNK-13). `dev/console` shows what its screen shows.

1. The screen says “Open localhost:5190/link and enter ABCD-EFGH”. Open http://localhost:5190/link, sign in with any
   email (the link is in Mailpit, http://127.0.0.1:58025; it is written as `https://localhost:5190/…`, the web app
   here answers over plain HTTP, so change `https` to `http`), type the code and confirm. The free month starts and
   the box's Link is on within a few seconds.
2. The screen then says “Claim this Whombat” with four letters like `KXQM` and the box's own page,
   `localhost:4621/`. Open http://localhost:4621/ and type the letters (`dev/console --watch` redraws when they
   change, e.g. new letters after a wrong try). The claim runs on that page, never through control.

The console is drawn by the appliance's own `whombat-console`, built from this checkout into
`~/.cache/whombat-mgd/bin/` (needs Go; without it `dev/console` prints a one-line summary). No own address is given
out here (`WB_MGD_OWN_ADDRESS*` below switches that on), so the box's page is the loopback one; a real box shows its
`https://<label>.box.whombat.app` address instead.

## The manifest

```sh
manifest/pin                # pinned commits vs their refs
manifest/pin --refresh [id] # move pins to the refs' heads (then rebuild)
manifest/build [--only id]  # clean clones at the pins, frozen installs, builds, artifact digests
manifest/validate           # ProductManifest schema + pins + build report
```

Files: the pins of the checked-out commit are written to `<WB_MGD_HOME>/pins/<commit>.json` the first time anything
reads them, from the component list (`manifest/components.json`); the build report, the strict `@whombat/release`
ProductManifest and its annotations are written beside them. `manifest/pins-at [<commit>]` writes the pins of any
commit of this repository; `WB_MGD_PINS=<file>` makes everything use that set instead (the full validation passes the
pins of the release it checks). `manifest/pins.json` is the last set the flow before the one repository validated.

## Troubleshooting

- A service failed: `dev/status` shows the reason; `dev/logs <service>`; the first line of the error names the log.
- "the committed lockfile does not install from a clean checkout": fix the lockfile in that repository (or
  `--lockfile-drift`, recorded in env.json and reports).
- Magic-link rate limits (control: 5 per email, 30 per IP per hour): the scenarios cache cloud sessions in
  `env/sessions.json`; a fresh environment (`--reset`) and repeated demos use new emails.
- A box is claimed once: `dev/up --reset` gives a new appliance.
- `dev/console` shows “Starting Whombat…”: the runtime hasn't written `env/run/console.json` (not running), or the
  manager hasn't told it yet how the box is reached. No Link code: `dev/logs manager` says what control answered to
  `link.begin` (control needs an https account-site address, `UI_URL`; `dev/up` gives it one). Too many wrong
  letters put the appliance into a backoff the console counts down.
- A leased Postgres: on a machine whose temporary containers must be leased, `WB_MGD_PG_RUN` names the command that
  starts one (it gets `--publish`, `--env`, the image and Postgres's settings, and prints the container's name).
