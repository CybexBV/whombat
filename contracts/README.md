# contracts/

Pure, versioned contracts shared by every Whombat component: the data types, the API contracts, the relay and
session protocols, the claim ceremony and the secure channel, in TypeScript and Go. They were the whombat-contracts
repository until it moved into Whombat (`docs/decisions/one-repo.md`). The TypeScript packages are in `packages/` with
the rest of the workspace; this folder holds what isn't TypeScript, and what releases them for other repositories:

| Path | What |
|---|---|
| `go/` | The Go module `github.com/CybexBV/whombat/contracts/go` (released as `whombat-contracts-go-<v>.tar.gz`), with its `LICENSE` |
| `schema/` | JSON Schema of the cross-language subset (released with `vectors/` as `whombat-contracts-schema-<v>.tar.gz`) |
| `vectors/` | Conformance vectors every implementation must pass |
| `conformance/` | `@whombat/conformance`: the cross-language registry and the generator of `schema/`, `vectors/` and the Go bindings, with their tests |
| `scripts/` | `release.ts` (`pnpm contracts:release`), the smoke consumer, `link-contracts.sh` for other repositories |

## Packages

| Package | Subpaths | What |
|---|---|---|
| `@whombat/core` | `.`, `./domain`, `./contracts`, `./keys`, `./skills`, `./approvals`, `./audit`, `./automations`, `./feedback`, `./feedback/sanitize`, `./feedback/drop`, `./feedback/reporters`, `./text`, `./text/utf8`, `./vault`, `./commands`, `./backup`, `./share`, `./ids` | Domain, REST contracts (`api`), keys engine, skills, audit/signing, strict UTF-8 without `TextDecoder` (`./text/utf8`), the Vault's rules, the agent's commands (the command guard), backup files (container, tar, records), shared links' sealed snapshots (`./share`) |
| `@whombat/canvas-schema` | `.`, `./tiptap` | Canvas document schema |
| `@whombat/fixtures` | `.`, `./fetch` | Mock world |
| `@whombat/protocol` | `.`, `./relay`, `./direct`, `./admission`, `./licence`, `./claim`, `./frame`, `./session`, `./collab`, `./console` | Relay protocol v1, the direct connection to the box (no relay), admission tickets, the appliance licence, the claim ceremony (claim code, CPace), session protocol v1, console stream payloads (a server's shell or a VM's screen over the session) |
| `@whombat/control-contracts` | `.`, `./device`, `./local` | Control API; device-signed API; appliance-local IPC |
| `@whombat/release` | `.` | Release tuples, integration manifest, update journal, assignments, client bundles and the client channel, compatibility |
| `@whombat/secure-channel` | `.`, `./node` | Noise XX session over an injected byte stream |

The packages import nothing from the runtime or the apps.

```sh
pnpm check                           # biome + typecheck + vitest of the whole repository (incl. conformance vectors)
pnpm contracts:test:go               # go vet + go test (same vectors)
pnpm contracts:gen                   # regenerate JSON Schema, vectors, Go bindings
pnpm contracts:gen:check             # verify they're up to date (CI)
pnpm contracts:release               # from a clean tagged tree → dist-release/contracts/<version>/
```

Docs (`docs/contracts/`): [publishing](../docs/contracts/publishing.md),
[cross-language subset](../docs/contracts/cross-language.md), [session protocol](../docs/contracts/session-protocol.md),
[local IPC](../docs/contracts/local-ipc.md), and the contracts' decisions in `docs/contracts/decisions/` (CT- codes).
The privacy and security model is `docs/app/privacy-and-security.md`.
