# The “latest tested” client job (SUB-09, CT-74, MG-33)

> Commands written `dev/<name>` are the maintainers' (`bin/<name>` in their private whombat-ops). Anyone can run
> the same code: `node harness/src/dev/<name>.ts` (`dev/prune` is `prune-copies.ts`, `dev/devbox` is
> `harness/src/devbox/main.ts`), after `pnpm install --frozen-lockfile` in `harness/`.

Customers' appliances install Claude Code at the **latest version Whombat has tested**. This job follows upstream,
tests each new release against Whombat's provider tests and publishes it in the signed client channel only when they
pass. It stops at publishing: it never changes Whombat's committed pins (bumping those stays a person's change, Whombat
`docs/managed/provider-bundles.md` “Bumping a pin”) and never pushes anything.

**Claude Code only since 2026-10-25 (IN-432).** ChatGPT runs on Hermes's own provider with no client (Whombat
`docs/decisions/hermes-native.md` HN-04, HN-A01…HN-A04): the job no longer follows, tests or publishes Codex
(`--only codex` and `--version codex=…` are refused, `clientchannel latest|fetch --provider codex` too), and the dev
stack seeds Claude Code's bundle alone. Codex bundles already in a channel stay there, re-signed with it, until someone
withdraws them; nothing installs them any more (the runtime reports a Codex adapter level no bundle has, refuses Codex
installs and removes a Codex the manager still has). To drop them from a channel:
`go run ./release-tools/cmd/clientchannel publish --repo … --withdraw codex/<version>` per version
(`clientchannel show` lists them); that also removes their artifacts from the repository.

Hermes Agent itself has a job of its own, which pins and ships it: `docs/runbooks/hermes-latest-tested.md` (NX-485).

Script: `release-tools/clients/latest-tested` (with `bump-pins.mjs` and the Go publisher
`release-tools/cmd/clientchannel`).

## What one run does

1. **Detect.** Upstream's latest release: npm's `latest` dist-tag of `@anthropic-ai/claude-code`, held back to the
   version Whombat's branch pins (`CLAUDE_BUNDLE.version`, the newest Claude Code Nous's DirectSDK is known to handle,
   Whombat HN-K08; IN-433): a newer release waits for a Whombat pin bump, and the pin itself is tested instead.
   `--version claude=X` isn't held back. A version that is already the channel's newest for this architecture is
   skipped; so is a version that failed before (until `--retry-failed`).
2. **Fetch.** The official artifact, checked against the vendor's own digest: Claude Code from
   `downloads.claude.ai/claude-code-releases/<v>/linux-<x64|arm64>/claude` against that version's `manifest.json`
   checksum (the npm platform packages `@anthropic-ai/claude-code-linux-*` carry the byte-identical binary; their
   integrity is recorded too). The other platform's digests and the npm integrities are fetched for the pin bump.
3. **Test in a scratch clone.** `git clone --depth 1 --branch main file://~/Code/Whombat` into the job's work
   directory; `bump-pins.mjs` moves that clone to the new version (the version, release and npm digests and the
   executable sha256 in `packages/agent-runtime` and `pnpm-workspace.yaml`, and the fixture's file name while Whombat
   has one); `pnpm install` (the npm platform packages move to the new version); while Whombat still pins a protocol
   fixture for Claude Code (before Whombat HN-K01: `CLAUDE_BUNDLE.fixture` not null),
   `pnpm --filter @whombat/agent-runtime provider:fixtures --only claude` regenerates it from the new executable
   (offline: an empty network namespace, a fake Messages API); `pnpm --filter @whombat/agent-runtime test` runs the
   agent-runtime tests, the offline binary tests included (Whombat `bundles.test.ts`: `initialize`, `get_usage`, no
   self-update, `apiKeyHelper`). Any failure stops here: nothing is published and the log says why.
4. **Bundle.** `clientchannel bundle`: the unmodified executable in a reproducible tar.gz, unpacked with the manager's
   own code to hash the executable; `fixturesDigest` = sha256 of the regenerated fixture, or, for a Whombat without
   one, the executable's own sha256 (what the tests ran against, IN-432); `adapter` = Whombat's
   `CLIENT_ADAPTER_LEVELS.claude` (`providers/clients.ts`; override: `WB_CLIENTS_ADAPTER_CLAUDE`); `testedAt` = now.
5. **Publish.** `clientchannel publish`: a new channel (sequence + 1, valid 7 days) with the new bundles first, the
   previous ones kept (4 per provider and architecture, for rollback and older runtimes), signed with the clients key,
   as the `clients` role's targets with snapshot and timestamp, plus the plain `clients/channel.json` for self-hosted
   servers. Without anything new it only re-signs when the channel expires within 5½ days (`refresh --within 132h`;
   every 6 h, so it keeps more than the 5 days below which control's `client_channel_expiring` opens, IN-224).

Only this host's architecture is tested and published (the tests must run on the executable they certify): x86_64
here. aarch64 needs an arm64 runner (below).

## Install the timer (an operator's step; don't enable it from a work session)

The job publishes into the GitHub repository's clone (`WHOMBAT_RELEASES_DIR`, ONE-01: one environment), which has the
clients role from `gh-continue`. It runs from its own clone of Whombat, `~/Services/whombat-jobs`
(`appliance/release-tools/clients/latest-tested`), pulled before each run; the maintainers' `instance/install-jobs
--yes` makes it and installs the units (their `retire-dev.md` “The jobs”):

```sh
cp "$(git config whombat.ops)"/instance/clients-latest-tested.env ~/.config/whombat/clients-latest-tested.env   # defaults are fine
"$(git config whombat.ops)"/instance/install-jobs --yes
systemctl --user start whombat-clients-latest-tested.service      # a first run now (journal below)
```

The unit is a oneshot (3 h limit, nice 10, idle I/O), every 6 h (00/6:17 + up to 20 min). It needs `node` 24, `pnpm`,
`go`, `git`, `jq`, `curl`, `unshare` (the fixtures' offline namespace), and `gh` logged in or `GITHUB_TOKEN` (GitHub API
rate limit). State: `~/.local/state/whombat-clients/` (`logs/` one log per tested version, `bundles/`, `artifacts/`,
`markers/<provider>-<version>-<arch>.{ok,failed}`, `work/` a failed run's clone, `job.lock`).

```sh
journalctl --user -u whombat-clients-latest-tested -n 100
release-tools/clients/latest-tested --dry-run                     # test what's new, publish nothing
release-tools/clients/latest-tested --retry-failed                # test a failed version again
release-tools/clients/latest-tested --version claude=2.1.283      # test (and publish) a given version
go run ./release-tools/cmd/clientchannel show --repo "$WHOMBAT_RELEASES_DIR"
go run ./release-tools/cmd/clientchannel publish --repo … --withdraw claude/2.1.290   # pull a bad version
```

Verified 2026-11-19 (IN-835): `--dry-run` against a copy of the clone's metadata and clients targets, its own state and
no token: Claude Code 2.1.302 (Whombat's pin; upstream had 2.1.328, held back by IN-433) is in the channel, nothing to
test or publish.

A failed version: read its log (`logs/<provider>-<version>-*.log`, the last 40 lines are also in the journal). If the
new version changed something Whombat uses, the fix is a Whombat change (adapter, fixture expectations; then maybe a
new adapter level); after it is on Whombat main, `--retry-failed`. Versions that fail are simply not offered to
devices; they keep the last tested one.

History (before IN-432, when the job still followed Codex): verified 2026-09-26, `--dry-run --only codex` tested Codex 0.157.1 (upstream latest; the channel had 0.157.0)
against Whombat main: fixtures regenerated, 422 agent-runtime tests passed, bundle built (executable
`3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970`); nothing published.

Verified 2026-09-26 against an isolated `dev/up` (own `WB_MGD_HOME`, ports and Postgres; candidate 0.9.0, live
agents), `WB_CLIENTS_REPO=<its env/manager/tuf>`, own `WB_CLIENTS_STATE`: Claude Code 2.1.283 and Codex 0.157.1 tested
against Whombat main d27b239 and published as channel 1 (`clients-local-…` key); the manager installed both from it
and `scenarios/k-live-agents` ran against them (IN-38). The same run upgraded a 0.8.1 scripted environment in place
first, as the dev instance will be.

## The GitHub repository (Whombat LNK-24, LNK-50, ONE-01)

Every box reads the client channel from the GitHub repository. The job signs it in the publisher's clone (`publish`
with new bundles, else `refresh` within 5½ days of its expiry: the role lasts 7 days), then `tufrepo gh-clients --dir
<clone>` uploads its files and pushes its role. The clone and the token come from `~/.config/whombat/releases.env`
(`WHOMBAT_RELEASES_DIR`, `WHOMBAT_RELEASES_TOKEN`, as for `candidate`; `WB_CLIENTS_GITHUB` and `WB_CLIENTS_RELEASES_ENV`
override them). When the upload fails (a release publish holds the clone, GitHub is down) the run ends with exit 1 and
the next run finishes it; by hand: `tufrepo gh-clients --dir <clone>`. A `WB_CLIENTS_REPO` that isn't the clone (DEV's
repository, before DEV was retired) is published into and mirrored into the clone byte for byte (`clientchannel mirror`),
as before ONE-01. After `tufrepo gh-clients-env --env prod` (ONE-05) the channel is signed for production boxes.

## Moving it to CI for production

The same script runs in CI; what changes is where the keys and the repository live.

- **Runners:** one x86_64 and one arm64 Linux runner (each publishes only its own architecture's bundle; the two
  bundles of a version go in one channel: run both, then one publish step with both `--bundle` files). Each needs the
  tools above and unprivileged user namespaces (`unshare -rn`) for the offline fixtures.
- **Schedule:** every 6 hours plus a manual dispatch with `--version provider=version` and `--retry-failed`.
- **Whombat:** a clean checkout of this repository’s `main` instead of `file://~/Code/Whombat`
  (`WB_CLIENTS_WHOMBAT`), read-only token.
- **Signing:** the production clients key lives in the CI job's signer (KMS/HSM, usable by this job only; custody in
  `docs/runbooks/updates-release-signing.md`). The job does not hold snapshot/timestamp keys: instead of
  `clientchannel publish --repo`, it produces the signed channel, the new `N.clients.json` role version and the
  artifacts, and hands them to the release publishing service, which checks the role signature and the delegation
  paths, uploads the targets and signs snapshot and timestamp (the publishing service's existing online keys). That
  handoff is the one piece still to build (a `clientchannel` mode that signs a role version against a fetched
  repository and writes an upload bundle); the channel format, bundle building and tests are unchanged.
- **Gate:** the job's test step is the gate — CI must never skip it, and a manual publish of an untested version is
  not a supported path. Release officers can pull a version at any time (a channel without it).
- **Plain channel:** publish `clients/channel.json` to the updates CDN root too (self-hosted servers, SUB-26:
  `https://updates.whombat.com/clients/channel.json`), with production keys in their `WHOMBAT_CLIENT_CHANNEL_KEYS`.
