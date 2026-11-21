# Developing Whombat

How to build, run and test Whombat from this repository. What Whombat is and how to install it: the
[README](../README.md). How it works inside: [ARCHITECTURE.md](../ARCHITECTURE.md); the decisions in force:
[DECISIONS.md](../DECISIONS.md); the guide for coding agents: [CLAUDE.md](../CLAUDE.md) (also `AGENTS.md`).

## What this repository is

This is the source of Whombat, made by Cybex BV, where its maintainers work in the open. It holds everything that
runs on a Whombat box and the apps people use it with:

- the **runtime**: the server, the runner that runs the assistant's turns on Hermes Agent, and the network of the
  assistant's commands (`apps/`, `packages/`);
- the **box's system** in `appliance/`: the NixOS image, the device manager, the update helper and release signing;
- the **server monitoring service** and its agent in `hosts/`;
- the **apps**: web, Android and iOS, and the Feedback widget;
- the **contracts** between them (`packages/core`, `packages/protocol`, `contracts/`, …).

What isn't here: Whombat's cloud services (control, the relay, the update service and the phone push service) and the
operator panel. The product spec and design references (`docs/design-handoff/`) and the decisions behind the code
(`DECISIONS.md`, `docs/decisions/`) are.

You can read it, build it, run its tests, and run a **community box** from it: the same runtime, without a licence
check, relay or control, that you claim and use in a browser on your own machine.

## Run a community box from source

### What you need first

- Node.js 24
- pnpm 12 (`corepack enable` picks up the pinned version from `package.json`)
- Docker (Postgres 17 and Mailpit via `docker compose`)
- Linux with bubblewrap (`bwrap`), `nsenter` and a systemd user session: every agent turn runs in the runner's
  sandbox, and each of the agent's commands runs in a bubblewrap wrapper of its own
- Python 3 for the CI driver; C/C++ build tools and Python for the native PTY addon installed by pnpm
- For the real Hermes instead of the scripted one: `pnpm hermes:install` (Python 3.14 through uv), and Claude Code
  signed in or a ChatGPT sign-in (Hermes's own)

### Quick start

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d              # Postgres :55432, Mailpit SMTP :51025 / UI :58025
pnpm build:web                    # the page the box serves (apps/web/dist)
WHOMBAT_EDITION=community pnpm dev
```

The server logs `Open http://localhost:…/ to use this Whombat in a browser here.` and a claim code: open the link,
claim the box with the code, and you're in. `.env.example`'s `DATABASE_URL` is the Compose file's Postgres; change
`PORT` and `WHOMBAT_HOME` (default `~/.whombat`) when you need to. Put `TMPDIR` on a disk with room to spare if your
`/tmp` is small: every test run makes a temporary folder of its own there.

`pnpm dev` (`scripts/dev.ts`) runs the server, the runner and the agent's commands' network as one box with
development's stand-ins: the box's identity made at the first start (`$WHOMBAT_HOME/identity/content.key`), a
stand-in manager on `$WHOMBAT_HOME/manager.sock`, a stand-in Tailscale, a fake GitHub, the agent's commands in their
bubblewrap wrappers, and the scripted Hermes, which answers without any AI account (`WHOMBAT_HERMES_BIN`, with
`WHOMBAT_ALLOW_SCRIPTED=1`). For a real agent, `pnpm hermes:install` and set `WHOMBAT_HERMES_BIN` to it. Its boot
migrates the database.

```sh
pnpm check                        # lint, typecheck and every package's unit tests
pnpm db:seed                      # the mock world, in your own database only
pnpm dev:ask "What is Dusty working on?"   # in another shell: ask the agent in the first owner's Chat
pnpm dev:web                      # the web app with hot reload at :5180, against a running `pnpm dev`
```

The apps: [docs/app/README.md](app/README.md) and [apps/mobile/README.md](../apps/mobile/README.md).

## The box's system and the server agent

`appliance/` and `hosts/` have their own tools, and their own READMEs say how to use them:

- `appliance/`: Go 1.26 for the manager, the helper and the box's services (`go test ./...`, with git, gcc, `jq` and
  `dbus-daemon` installed), Nix for the images. There is a community edition of the image
  (`appliance/nix/profiles/community-instance.nix`) without control, relay, licence or remote help; it has test keys only.
- `hosts/`: a Go module with a `Makefile` (`make test`, `make headless` for what the box runs, `make agents-unsigned`
  for the server agent).

Building an image or a VM test is heavy: give it a machine with room to spare.

## Layout

| path | package |
|---|---|
| `apps/server` | `@whombat/server` — the session endpoint, Fastify 5 on loopback (runner protocol, MCP, AI gateway relay), Drizzle + Postgres |
| `apps/runner` | `@whombat/runner` — runs agent turns on Hermes in its sandbox |
| `apps/agent-net` | `@whombat/agent-net` — the agent's commands' network: their proxy with the wall |
| `apps/cli` | `@whombat/cli` — the runtime bundle's `bin/whombat` (`schema-check`, `migrate`, `version`) |
| `apps/web` | `@whombat/web` — the web app: the box's own page and the hosted app (app.whombat.com); the app's version |
| `apps/mobile` | `@whombat/mobile` — the Expo app (Android first, iOS) |
| `apps/widget` | `@whombat/widget` — the Feedback widget websites embed |
| `packages/client` | `@whombat/client` — the apps' encrypted session, transport and view models |
| `packages/tokens`, `packages/avatars`, `packages/brand` | design tokens, the agent's faces, the logo and service marks |
| `packages/core` | `@whombat/core` — the domain model, Zod contracts, keys engine, approvals, audit; pure (no I/O) |
| `packages/protocol`, `packages/secure-channel` | the session protocol and its Noise channel; the claim ceremony |
| `packages/fixtures`, `packages/canvas-schema`, `packages/control-contracts`, `packages/release` | the mock world, the canvas schema, control's contracts, release manifests |
| `contracts/` | the contracts' Go module, JSON Schema, conformance vectors and their generator, and `pnpm contracts:release` |
| `tools/visual` | `@whombat/visual-tools` — the comparison with the HTML references |
| `packages/agent-runtime` | `@whombat/agent-runtime` — every turn on Hermes Agent (`hermes/`), Claude Code's checks and sign-ins, ChatGPT's sign-in steps through Hermes, the managed sandbox, workspaces |
| `packages/commands` | `@whombat/commands` — the agent's commands: the launcher, the holder and the gh/git/`whombat` helpers |
| `packages/node-io` | `@whombat/node-io` — Node-only HTTP and tar mechanics (`./http`, `./tar`); caller policy stays in the apps |
| `packages/screen` | `@whombat/screen` — the screens of widgets: the grid, the widgets' sizes and forms and their drawing (`./react`), pure TypeScript with no zod so the box's console takes the source as it is |
| `packages/hermes-whombat` | Whombat's plugin for Hermes Agent (Python) |
| `scripts/package` | `@whombat/package` — the appliance's runtime bundle |
| `appliance/` | the box's system: its NixOS modules and images, the device manager, the update helper, the box's own screen, backups, recovery and release signing (`appliance/README.md`) |
| `hosts/` | the server monitoring service the box runs (`whombat-hosts`) and the small agent on each server (`whombat-agent`), in Go (`hosts/README.md`) |

Workspace packages are consumed as TypeScript source (`workspace:*`): one commit changes a contract and the server and
apps that use it. The apps' and the contracts' own docs are in `docs/app/` and `docs/contracts/`. Code outside this
repository, such as Whombat's cloud services, takes the contracts as releases: `pnpm contracts:release`, see
[contracts/publishing.md](contracts/publishing.md).

## Scripts

| script | what it does |
|---|---|
| `pnpm check` | Biome (lint + format check), the third-party notices check, typecheck every package, all unit tests. Must pass before finishing work. |
| `pnpm dev` | The server, the runner and agent-net as one development box (above) |
| `pnpm dev:ask "<text>"` | Ask the agent in the person's Chat on the running development box and print its answer |
| `pnpm build` | Run every workspace build script (the apps' builds and the contracts packages' `dist/`) |
| `pnpm build:web` / `build:web:hosted` / `build:widget` / `build:embed` | The box's page (`apps/web/dist`), the hosted app (`dist-hosted`), the widget, its embed tree |
| `pnpm dev:web` | The web app at :5180 (and the widget) against a running `pnpm dev` |
| `pnpm e2e:managed` / `pnpm e2e:box` / `pnpm visual` | The hosted app's and the box page's Playwright journeys / the comparison with the HTML references (`ref:shot`, `visual:diff`: `tools/visual/README.md`) |
| `pnpm e2e:runtime` | The web app's Playwright journeys against a real disposable runtime: a throwaway Postgres database, the encrypted direct session and the scripted Hermes runner |
| `pnpm test` / `pnpm test:watch` / `pnpm test:coverage` | Unit tests of every workspace package (Vitest projects) |
| `pnpm test:server` | Server integration tests against Postgres; each test file gets a throwaway `whombat_test_<random>` database and boots the server as `pnpm dev` does |
| `pnpm test:cli` | `schema-check` and `migrate` against a throwaway database |
| `pnpm hermes:install` | The pinned Hermes Agent with our plugin, for the real engine (`WHOMBAT_HERMES_BIN`) |
| `pnpm hermes:test` / `pnpm hermes:e2e` | The plugin's Python tests / `HermesProvider` against the real `hermes acp` on this machine |
| `pnpm hermes:test --hermes latest\|pin\|<tag>` | The plugin's Python tests on another Hermes release, in a fresh environment under `$TMPDIR` (CI's daily `hermes-latest` job); the pin stays |
| `pnpm hermes:pod-e2e --env <hermes environment>` | The person's pod with the real Hermes, a stub model and the real managed sandbox: checks what the pod promises, measures a turn's start and prints a JSON report (`pnpm hermes:test --hermes pin --keep` makes the environment) |
| `pnpm assistant-settings:gen` | Write the assistant's `whombat:settings` skill into the Hermes plugin from the settings map; run it after changing that map (`pnpm check` fails while they differ) |
| `pnpm whombat <command>` | The runtime bundle's CLI from the checkout: `schema-check`, `migrate`, `version` |
| `pnpm bundle:runtime` | The appliance's runtime bundle into `dist/` (`--arch`, `--version`, `--verify-reproducible`) |
| `pnpm contracts:release` | Release the contracts for other repositories: `dist-release/contracts/<version>/` (`docs/contracts/publishing.md`) |
| `pnpm contracts:gen` / `contracts:gen:check` / `contracts:test:go` | Regenerate the contracts' JSON Schema, vectors and Go code / check they're up to date / the Go module's tests |
| `pnpm app:release` | The box's page as one checksummed archive, `dist-release/app/<version>/` (`docs/app/publishing.md`) |
| `pnpm notices` | Regenerate `THIRD_PARTY_NOTICES.md` (`--check` to verify) |
| `pnpm decision-ids` | Check that each decision id is defined in one decision file and that every id cited in code appears in the docs (`--write` rewrites `scripts/decision-ids/baseline.json`) |
| `pnpm db:migrate` | Apply Drizzle migrations to `DATABASE_URL` |
| `pnpm db:reset` | Drop and recreate the schema, then migrate — only your own disposable database |
| `pnpm db:seed` | Load the mock world (`--relative` shifts it to today) |
| `pnpm demo:play` | Play the demo storyline in the running server: Dusty's run reaches 41 of 41, Mara approves, the staging deploy goes out (`WHOMBAT_DEMO=1` plays it on start; the agent is the scripted Hermes) |
| `pnpm demo:reset` | Rewind the demo storyline to 11:22 |
| `pnpm soak:managed` | The server and the runner idling as an appliance nobody uses, failing when the server's memory grows |
| `pnpm ci:check` | The CI phases (`scripts/ci/check.py`) |
| `pnpm readme:shots` | The README's pictures in `docs/readme/`, from the demo world in fixture mode, light and dark (`apps/web/readme/`); look at each before committing |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Biome check / typecheck every package / apply Biome fixes and formatting |

The browser, visual and Android suites stay out of `pnpm check`. Run checks
with Node 24 and the `TMPDIR` above, one repository at a time.

## Licence

Copyright 2026 Cybex BV. The code is free software under the GNU Affero General Public License, version 3 only
([LICENSE](../LICENSE), `AGPL-3.0-only`). The assistant's skills are Hermes Agent's (MIT), and a skill installed from
Hermes's hub keeps its own licence. Third-party code keeps its own licence
([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)). The licence gives no rights in the name “Whombat” or its logos: a
fork needs its own ([TRADEMARKS.md](../TRADEMARKS.md)). Pull requests are merged under the contributor agreement
([CONTRIBUTING.md](../CONTRIBUTING.md)); security reports: [SECURITY.md](../SECURITY.md).
