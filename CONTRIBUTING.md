# Contributing

Whombat is free software under the AGPL-3.0 (`LICENSE`), made by Cybex BV. Bug reports, ideas and pull requests are
all welcome.

## Before you start

- **A bug or an idea:** open an issue and pick the form that fits. Say what you did, what you expected and what
  happened.
- **A question about running Whombat:** ask in [Discussions](https://github.com/CybexBV/whombat/discussions).
  Whombat Link subscribers can also write to info@whombat.com.
- **A security or privacy problem:** never in a public issue or discussion. Report it privately, see `SECURITY.md`.
- **A larger change:** open an issue first, so we agree on the approach before you write the code.

## The contributor agreement

We merge a pull request once you have agreed to the Whombat contributor agreement
(`docs/legal/contributor-agreement.md`). Why we ask for it, in short:

- It lets Cybex BV publish your work under the AGPL-3.0 and also offer Whombat under other terms. That is how
  Whombat Link and the boxes we sell pay for the work on the free software.
- You keep the copyright in your work.
- In return we promise that, for as long as we distribute Whombat, it stays available under the AGPL-3.0, a later
  GNU AGPL, or another licence the Open Source Initiative approves (section 4).

To accept it, write this line in your first pull request (the pull request form has it):

> I accept the Whombat contributor agreement.

An organization can accept it for its staff by email to legal@whombat.com. Reporting a bug, suggesting an idea or
asking a question needs no agreement.

## Setting up

You need Linux (the assistant's commands run in bubblewrap under a systemd user session), Node.js 24 with
`corepack enable`, and Docker for Postgres and Mailpit. Go and Nix are only needed for `appliance/` and `hosts/`.
`docs/development.md` has every step; the short version:

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d
pnpm build:web
WHOMBAT_EDITION=community pnpm dev
```

While you work, run `pnpm lint`, `pnpm typecheck` and the test file you are changing (`pnpm exec vitest run <file>`).
Before a pull request, run `pnpm check`. With its defaults it type-checks every package at once, which needs more than
20 GB of memory; on a laptop run it the way public CI does:

```sh
CHECK_JOBS=1 TYPECHECK_JOBS=2 pnpm check
```

A change in `appliance/` or `hosts/` also runs that folder's own tests (`appliance/AGENTS.md`, `hosts/AGENTS.md`).

## How a pull request lands

- **`public-ci`** runs on GitHub's own runners, with no secrets and a read-only token, and must pass.
- **`guard`** is the maintainers' check: it compares each change with a private list of values that must never be
  published (the maintainers' own addresses, machines and accounts). You can't run it yourself. If it stops your pull
  request, a maintainer tells you what to change.
- **Fixed hashes:** a change to a lockfile, a `go.mod` or a `go.sum` needs the hash of the NixOS build's download
  refreshed (`appliance/nix/fixed-hashes.json`). That needs Nix: a maintainer adds it to your pull request.
- We merge it into `main` here. A release is one commit of `main`.

## Finding your way

- **The layout:** `apps/` holds the server, the runner, the network daemon, the CLI and the apps (web, mobile,
  widget); `packages/` the shared code and the contracts between the parts; `contracts/` their Go module, schema and
  test vectors; `appliance/` the box's NixOS system, its manager and the release tools; `hosts/` the server
  monitoring service and its agent; `docs/` the guides, the decisions and the product spec.
- **Codes like `HE-58` or `NX-445`:** each is one decision, a row in a file under `docs/decisions/` (or
  `docs/app/decisions/`, `appliance/docs/decisions/`, `hosts/docs/decisions/`). `DECISIONS.md` lists those in force
  and `docs/decisions/README.md` says which file covers what. Search for a code to find why something is the way it
  is.
- **How this project is built:** most changes are written by AI coding agents and directed and checked by the
  maintainers, with tests and reviews. `AGENTS.md` is the agents' guide (`CLAUDE.md` is the same file) and also the
  shortest summary of the house rules. The notes in `docs/implementation/` are briefs written for those agents.
- **Names you can't follow:** `whombat-ops`, `fast-test`, `ci-platform`, `agent-resource`, `beast-resource`,
  `candidate` and `promote` are the maintainers' private tools, and “The Titan” and “The Falcon” stand for their own
  machines. You don't need any of them: `pnpm check` and public CI cover a contribution. `.fast-test.json` and
  `ci/platform/` configure that tooling.
- **The design:** the screens follow the product spec and visual references in `docs/design-handoff/`.

## House rules

- **Example values only:** fixtures and docs use the example ranges and names (`10.100.0.0/16`, `203.0.113.0/24`,
  `2001:db8::/32`, `example.com`), never a real network, address or account.
- **Code that isn't yours:** name its source and licence in your pull request; the licence must be compatible with the
  AGPL-3.0.
- **Plain words:** whatever Whombat says to people is short, plain English, and docs describe how things work today.
- **Be kind:** everyone here follows the code of conduct (`CODE_OF_CONDUCT.md`).
