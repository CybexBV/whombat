# Working on Whombat's hosts service (formerly Rackoon)

Since 2026-10-17 ("One Whombat") this folder, `hosts/` of the Whombat repository, builds Whombat's hosts
service: `whombat-hosts` runs headless inside the Whombat appliance and
serves the Whombat server over a Unix socket (`docs/WHOMBAT.md` is the
contract), `whombat-agent` runs on every monitored server. The Rackoon web
UI and its own sign-in still build and work without `--headless`, but the
product is Whombat (decisions: `docs/decisions/hosts.md`).

`README.md` has the layout, build and dev commands; `NOTES.md` the decisions,
deviations and what is verified. `docs/handoff/` is the original design brief.
Tools come from mise; `make test` runs Go and web unit tests (`go vet ./...`
and `go test ./...` for the Go side only).

## How to answer

- Always answer concisely and in plain English: short sentences, everyday words, the answer first. Leave out filler,
  jargon and long lists unless someone asks for more detail.

## Building and testing

- Tools come from mise (`mise install`). `make test` runs the Go and web unit tests (`go vet ./...` and `go test ./...`
  for the Go side only); `make ci` is what the pull request check runs.
- Try changes with a local headless hub and the simulated fleet (README, Develop), on your own ports and a data
  directory you own.
- A failing test runs once more before it counts as failing. Never skip or weaken a test to make it pass.

## Rules

- No secrets in the repo: passwords, tokens and keys stay on the hosts. Fixtures and docs use the example ranges and
  names (`10.100.0.0/16`, `203.0.113.0/24`, `example.com`).
- Whombat's appliance packages this folder (`../appliance/nix/packages/hosts`, `../appliance/nix/modules/hosts.nix`).
- The agents are signed: a change to their code (`cmd/whombat-agent`, `internal/agent` and what they import) is a new
  agent for every monitored server, so make one only when it is meant.

## Git

- Work on a branch; small, focused commits with imperative messages. Contributions arrive as pull requests on GitHub,
  under the contributor agreement (`../CONTRIBUTING.md`); `public-ci` must pass.
