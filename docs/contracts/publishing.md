# Publishing and consuming the contracts

The contracts (`packages/{core,canvas-schema,fixtures,protocol,secure-channel,control-contracts,release}`, the Go
module, JSON Schema and vectors under `contracts/`, plus the design tokens and the logo, `packages/{tokens,brand}`,
which the operator panel builds with) were a repository of their own until they moved into this one
(`docs/decisions/one-repo.md`). Inside this repository:

- the runtime and the apps build against their sources (`workspace:*`);
- the appliance's Go programs build against the Go module in place (`appliance/go.mod`: `replace … => ../contracts/go`);
- the appliance's harness still installs a release (`appliance/harness/vendor/whombat-contracts/<version>/`), and the
  console page keeps a copy of the few files it reads (`appliance/console/ui/vendor/`), until both join the workspace.

Code outside this repository, which is control and the relay in Cybex's private whombat-cloud repository, consumes the
contracts as immutable, vendored release tarballs (MA-02). There is no registry: a consumer commits the tarballs it
depends on and pins them with pnpm's lockfile integrity plus `SHA256SUMS`.

## Releasing

All publishable packages share one version (`packages/*/package.json` → `version`). A package is publishable
when it declares `publishConfig.exports` (only the seven contracts packages, `tokens` and `brand` do).

1. A change a box and an app of the same session major can't both live with — a session operation, an output, a
   frame or a union taken away or changed in meaning — is a new contracts major and bumps `SESSION_PROTOCOL.major`
   (`packages/protocol/src/session/version.ts`, CT-1260): the app and the box then refuse each other with
   `unsupported_version` until both are updated. Additions are minors (CT-14). There are no feature lists or API
   levels (HE-52).
2. Bump every publishable package to the new version, commit, and tag the commit
   `git tag -a contracts-vX.Y.Z -m "contracts X.Y.Z"`.
3. From the clean tagged tree: `pnpm contracts:release` (set `TMPDIR` if `/tmp` is small).
   - refuses a dirty tree, a tag that points elsewhere, or an existing `dist-release/contracts/X.Y.Z/` (immutable);
   - runs `pnpm check` (the whole repository), a clean build of the nine packages, then `pnpm pack` for each into
     `dist-release/contracts/X.Y.Z/`;
   - adds `whombat-contracts-go-X.Y.Z.tar.gz` (the `contracts/go` module) and `whombat-contracts-schema-X.Y.Z.tar.gz`
     (`contracts/schema` JSON Schema and `contracts/vectors` conformance vectors, under their own names `schema/` and
     `vectors/`);
   - builds every artifact a second time from scratch and refuses the release unless the bytes are identical
     (CT-54, see *Reproducible artifacts* below);
   - writes `SHA256SUMS` (all tarballs) and `RELEASE.json` (version, tag, commit, packages, subpaths, hashes, and
     `reproducible {archiveMtime, trees}`);
   - installs the tarballs and the packages' peers (react) into a scratch consumer
     (`contracts/scripts/smoke-consumer.ts`) and imports every published JavaScript subpath with plain Node, with
     tsx, and typechecks the imports with `moduleResolution: nodenext` (`@whombat/tokens/tokens.css` is a file);
   - prints the consumer install snippet.

Packed `package.json` files point `exports` at `dist/*.js` + `dist/*.d.ts` (from `publishConfig.exports`);
`workspace:*` dependencies become the exact release version. Inside this repository the same packages export
their TypeScript sources, so tests and typecheck never need a build.

## Reproducible artifacts (CT-54)

- Package tarballs come from `pnpm pack`: fixed mtime (1985-10-26T08:15:00Z), uid/gid 0, gzip without a
  timestamp.
- The Go and schema tarballs are `git archive` output for a tree object, never a commit, so there is no pax header
  with a commit id. The command is `git -c tar.umask=0022 archive --format=tar.gz --mtime=@499162500
  --prefix=<prefix> <tree>`. Entries are in git tree order, modes 0644/0755, uid/gid 0, and git's internal gzip adds
  no timestamp.
- `RELEASE.json` → `reproducible.trees` gives the tree ids: `go` for the Go module, and `schema` for a tree holding
  `schema/` and `vectors/`.

To rebuild the Go tarball from a consumer's vendored copy and compare:

```sh
cp -r third_party/whombat-contracts-go /tmp/rebuild && cd /tmp/rebuild && rm -f VERSION   # only the tarball's files
git init -q && git add -A
git write-tree                                   # = RELEASE.json reproducible.trees.go
git -c tar.umask=0022 archive --format=tar.gz --mtime=@499162500 \
  --prefix=whombat-contracts-go/ -o /tmp/go.tar.gz "$(git write-tree)"
sha256sum /tmp/go.tar.gz                         # = SHA256SUMS
```

The tree id doesn't depend on the git version. The gzip bytes come from git's zlib, so compare the tree id when
the gzip output of a different git build differs. Git ≥ 2.44 is needed for `--mtime`.

## Client bundles are published elsewhere (0.9, CT-74)

This repository only defines the client channel (`ClientBundle`, `SignedClientChannel`, `verifyClientChannel`,
`selectClientBundle`, and Go `release.VerifyClientChannel`/`SelectClientBundle`, with vectors in `clients.json`). The
CI job that follows upstream Claude Code and Codex releases, tests them and signs the channel lives with the appliance
release tooling. It publishes on its own schedule, not with a contracts release.

## Licence keys are not part of a release (0.10, CT-76)

This repository defines the licence token, the `LicenceKeySet` shape and the verifier. The only keys in it are the
TEST keys of `vectors/licence.json`, which are derived from the public vector seed and bound to
`whombat-appliance:test`. Real key sets come from control's licence keyring. The dev harness writes a dev image's set
from `GET /v1/licence/keys`, and a production set is created in the production key ceremony (LC-04). The NixOS module
`whombat.licence.keys` pins either into the image. None of them is ever committed here.

## Consuming (TypeScript repositories)

```sh
V=0.1.0
mkdir -p vendor/whombat-contracts/$V
cp ../Whombat/dist-release/contracts/$V/* vendor/whombat-contracts/$V/
(cd vendor/whombat-contracts/$V && sha256sum -c SHA256SUMS)
```

Depend on the tarballs with `file:` paths (only the packages you use), in whichever workspace package needs
them:

```json
"dependencies": {
  "@whombat/core": "file:../../vendor/whombat-contracts/0.1.0/whombat-core-0.1.0.tgz"
}
```

and pin every `@whombat/*` contracts package at the workspace root, so that transitive dependencies
(`@whombat/canvas-schema` → `@whombat/core@0.1.0`) resolve to the same vendored tarball instead of a registry
(paths in `overrides` are relative to the workspace root):

```yaml
# pnpm-workspace.yaml
overrides:
  '@whombat/core': 'file:vendor/whombat-contracts/0.1.0/whombat-core-0.1.0.tgz'
  '@whombat/canvas-schema': 'file:vendor/whombat-contracts/0.1.0/whombat-canvas-schema-0.1.0.tgz'
  '@whombat/fixtures': 'file:vendor/whombat-contracts/0.1.0/whombat-fixtures-0.1.0.tgz'
```

Commit the vendored directory, `package.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml` together. CI should
run `sha256sum -c SHA256SUMS` in the vendored directory. Upgrading = vendor the new version directory, update
the paths, `pnpm install`, remove the old directory once nothing references it.

Import names never change: `@whombat/core`, `@whombat/core/domain`, `@whombat/core/contracts`, … (see each
package's `exports`). The packages are ESM only (`"type": "module"`), target ES2023, and use no Node-only APIs
(Node 24, Vite/browsers, Metro/Hermes).

## Consuming (Go repositories)

Vendor the tagged module under `third_party/whombat-contracts-go/` (unpack
`whombat-contracts-go-X.Y.Z.tar.gz`, which contains `whombat-contracts-go/`) and add

```
require github.com/CybexBV/whombat/contracts/go v0.0.0
replace github.com/CybexBV/whombat/contracts/go => ./third_party/whombat-contracts-go
```

Record the contracts version in `third_party/whombat-contracts-go/VERSION`. The module depends on
`github.com/santhosh-tekuri/jsonschema/v6`, `github.com/gowebpki/jcs`, `filippo.io/edwards25519`,
`github.com/gtank/ristretto255` (0.7) and `github.com/mr-tron/base58`; `go mod tidy` in the consumer adds them to its `go.sum` (and `go mod vendor` for
offline builds).

## Development override (never committed)

To try unreleased contracts in another repository, copy
[`contracts/scripts/link-contracts.sh`](../../contracts/scripts/link-contracts.sh) into it as
`scripts/link-contracts.sh` and run

```sh
WHOMBAT_CONTRACTS_DEV=../Whombat scripts/link-contracts.sh                 # link
scripts/link-contracts.sh --unlink                                         # back to the vendored tarballs
```

It swaps the installed `@whombat/*` packages inside `node_modules/.pnpm` for symlinks to the contracts
checkout (TypeScript sources; run `pnpm install` in the contracts checkout first). Only `node_modules` changes;
`package.json`, the lockfile and `pnpm-workspace.yaml` are untouched, so a released build can never depend on
the sibling path. Any `pnpm install` restores the tarballs. Metro needs the contracts checkout in
`watchFolders`. For Go, use an uncommitted `go.work`:
`go work init . && go work use $WHOMBAT_CONTRACTS_DEV/contracts/go` (add `go.work*` to `.gitignore`).
