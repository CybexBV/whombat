# The Whombat appliance

The Whombat appliance: the NixOS system a Whombat box runs, with the programs around the Whombat runtime that keep it
working (`README.md` has the layout). It is the folder `appliance/` of the Whombat repository; paths here start at
this folder.

## How to answer

- Always answer concisely and in plain English: short sentences, everyday words, the answer first. Leave out filler,
  jargon and long lists unless someone asks for more detail.

## Before changing anything

- `README.md`: what is where.
- `docs/decisions/`: the decisions in force, one file per subject; read the one behind the code you change. Don't
  reopen them; record a new decision in the file of its subject.
- `docs/runbooks/`: how an image is built, installed, updated, backed up and recovered.

## Building and testing

- Go (the version in `go.mod`; git, gcc, `jq` and `dbus-daemon` installed): `go vet ./... && go test ./...`, and
  `gofmt -l` prints nothing.
- Node 24 with `corepack enable`: `pnpm install --frozen-lockfile && pnpm check` in `harness/` and in `console/ui/`;
  `pnpm --dir harness contracts:verify` checks the vendored contracts against their checksums.
- Nix with flakes: `scripts/ci/nix-eval.sh` evaluates the configuration checks, `scripts/ci/nix-checks.sh` builds them;
  the images (`release/build`) and the VM tests (`vm-tests/`) build whole systems. They are heavy: run them on a
  machine meant for it. The migration test (`update-migration`) needs an earlier release to update from
  (`vm-tests/common/migration-baseline.nix`): the repository names none, so it runs only where one is given.
- A failing test runs once more before it counts as failing. Never skip or weaken a test to make it pass.

## Rules

- The Go programs build against the contracts' Go module in this repository's `contracts/go` (`go.mod`'s
  `replace`). The harness and the console page still use a contracts release, vendored in `harness/vendor/` and
  `console/ui/vendor/`: never edit those copies here.
- No secrets, keys or real addresses in the repository. Fixtures and docs use the example ranges and names
  (`10.100.0.0/16`, `203.0.113.0/24`, `2001:db8::/32`, `example.com`).
- Code comments say why in plain words.

## Git

- Work on a branch; small, focused commits with imperative messages. Contributions arrive as pull requests on GitHub,
  under the contributor agreement (`../CONTRIBUTING.md`); `public-ci` must pass.
