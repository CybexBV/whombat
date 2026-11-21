# The Whombat appliance

The Whombat appliance: the NixOS system a Whombat box runs, with the programs around the Whombat runtime that keep it
working. A Whombat box holds one person's burrow (their Chat with one AI agent, its database and its files); this
folder is everything on the box except the runtime itself and the hosts service, which are built from the folders
beside it (`apps/`, `packages/` and `hosts/`). Paths below start at this folder.

- `nix/`, `flake.nix`: the NixOS modules, packages, profiles and the images built from them (a dedicated machine or a
  VM, the installers, the recovery environment).
- `manager/`: the device manager (updates, licence, backups, the runtime's admin socket); `helper/`: the restricted
  update helper that activates a verified release.
- `console/`: the box's own screen and its setup; `provisioning/`, `recovery/`, `backup/`: first start, recovery and
  backups; `network/`, `vaultwall/`, `bluetooth/`, `voice/`, `presence/`, `support/`, `kioskudev/`: the box's other
  services.
- `release/`, `release-tools/`, `manifest/`: building and signing releases (TUF), the product integration manifest;
  `harness/`: the integration environment and validation suite; `vm-tests/`: the NixOS VM tests.

## What this folder is

This is the source of the Whombat appliance, where its maintainers work in the open: the same code that builds the
images Whombat ships. You can read it, review how updates are verified, how data is backed up and what the box lets its
agent do, and run the Go tests (`go test ./...`, with Go 1.26, git, gcc, `jq` and `dbus-daemon` installed) and the
harness's and console's unit tests (`pnpm install --frozen-lockfile && pnpm check` in `harness/` and `console/ui/`,
Node 24 with `corepack enable`). `flake.nix` builds the Whombat runtime, the contracts and the hosts service from this
repository's own folders, through narrow copies of them (`nix/lib/sources.nix`), so every input it fetches is a public
one (nixpkgs, lanzaboote, Hermes Agent and the tools that package it). `scripts/ci/nix-eval.sh` evaluates the configuration checks without building them and
`scripts/ci/nix-checks.sh` builds them; the VM tests are `nix build .#checks.x86_64-linux.<name>` (`vm-tests/`, KVM
needed). Building an image or a VM test is heavy: give it a machine with room to spare. One VM test,
`update-migration`, updates a box from an earlier release; this repository has none of its own yet, so that test is
left out until one is named in `vm-tests/common/migration-baseline.json`.

There is a **community edition** (`nix/profiles/community-instance.nix`): the same image without control, relay,
licence or remote help, with its own update repository. It has test keys only, and no public update channel exists.

The decisions behind the code are in `docs/decisions/`, how an image is built, installed, updated and recovered in
`docs/runbooks/`. The maintainers' own operations (shipping to their boxes, remote help, their production) and the
update service's server, control and the relay are closed and live elsewhere; references such as `dev/candidate` or
a runbook that isn't here point at those. Older decisions and notes were written when the appliance was a repository
of its own: where they say “this repository”, read this folder.

**Issues and pull requests are welcome**, under the contributor agreement (`../CONTRIBUTING.md`). Security problems go
to `../SECURITY.md`, privately. The name “Whombat” and its logos aren't covered by the licence (`../TRADEMARKS.md`).

## Licence

Copyright 2026 Cybex BV. The appliance's code and the image built from it are free software under the GNU Affero
General Public License, version 3 only (`../LICENSE`, `AGPL-3.0-only`): you may use, study, change and share them, and if
you let people use a changed version over a network, you must offer them its source code too. The image also contains
software by others under their own licences, Hermes Agent's MIT notice among them (`THIRD_PARTY_NOTICES.md`); every
image carries both files in `/etc/whombat/`. The update service's server is closed and not in this repository; the
release tooling (`tufrepo`, `clientchannel`) stays here. The licence gives no rights in the name “Whombat” or its
logos: a fork needs its own (`../TRADEMARKS.md`). Issues and pull requests are welcome, under the contributor agreement
(`../CONTRIBUTING.md`); security reports: `../SECURITY.md`.
