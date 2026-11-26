# Building and publishing a release of the Whombat image

> Commands written `dev/<name>` are the maintainers' (`bin/<name>` in their private whombat-ops). Anyone can run
> the same code: `node harness/src/dev/<name>.ts` (`dev/prune` is `prune-copies.ts`, `dev/devbox` is
> `harness/src/devbox/main.ts`), after `pnpm install --frozen-lockfile` in `harness/`.

For whoever ships a Whombat image or update for the self-installed platform, dedicated machines and VMs
(`self-installed`, PI-01…PI-14, PI-18, PI-21…PI-23; before PI-22 `proxmox-vm` and `release/build-proxmox`).
Decisions: `nixos.md` NX-66…NX-70; publishing on production `prod-image.md` PI-11/PI-14 and control
`infra/hetzner/` (HZ-15…HZ-21); the manager's view `manager.md` MG-06, MG-09, MG-20, MG-41. Installing the ISO:
`install.md`.

**Releases come through `release/ship build` (UP-C1, UP-X45):** it runs `release/build prod` for the one Whombat
image (ONE-02; there is no DEV twin since ONE-01), checks it newer than Beta and records everything around it. The
maintainers' `candidate` runs it and publishes the release to Beta; their `promote` moves it to Production (IN-835). Run
`release/build` by hand only for a custody rollback (the maintainers' `shipping.md` “A bad release”). Mail automations
reach a box one release after the release that brings them: they come on once the release the box would go back to
knows them (`docs/release/compatibility.md`).

## What a release is

One **release id** names one `ReleaseTuple` (host toplevel, manager, runtime bundle, schema/protocol/ABI ranges). The
installer ISO of a host release installs exactly that toplevel, with `whombat.provisioning.selfFactoryRelease` = the
release id, so a freshly installed box provisions its manager journal and update helper with that tuple (MG-20) and
takes updates from its first boot. Every host release can have its own ISO, built on demand (UP-X15: `release/build
iso <dir>`, or `--iso` with the build); a runtime-only release reuses an earlier host and has no ISO (install the
host's ISO, the box updates itself).

**Release ids (NX-67, PI-23, ONE-04):** `whombat-YYYYMMDD.N` (UTC day of the build, `N` counting from 1 that day),
Beta and Production alike: a channel is which role lists a release, not its id. An id is never reused: TUF refuses a
second tuple under a published id. The DEV image's `whombat-dev-YYYYMMDD.N` ids stay published; boxes and the GitHub
repository order both families by day and number alone (LNK-22), so a new id must sort after every `whombat-dev-…` of
its day too (`N` above theirs: `nextReleaseId`, harness/src/dev/candidate-plan.ts). The ids before PI-23,
`pve-YYYYMMDD.N` and `pve-dev-YYYYMMDD.N`, stay published and sort before every `whombat-…` id; nothing signs a `pve-…`
id any more.

| Class | Built with | The box does |
|---|---|---|
| host (host or manager changed) | `release/build <env> <id>` | stages the host closure, switches at a reboot, boot counting, blesses after its health checks (MG-06) |
| runtime (bundle only) | `release/build <env> <id> --reuse-host <earlier build.json>` | switches the runtime profile and restarts the runtime, no reboot |

## Build (any machine with Nix and the Whombat source credentials; no keys)

From a **clean commit** of the appliance (prod refuses a dirty tree; the DEV image is gone, ONE-02):

```sh
TMPDIR=~/.cache/wb-tmp release/build prod whombat-20260927.1
# a runtime-only release on that host, after a Whombat pin bump (NX-42):
TMPDIR=~/.cache/wb-tmp release/build prod whombat-20261003.1 --reuse-host ~/.cache/whombat-releases/whombat-20260927.1/build.json
```

`--client-floor web=N,android=M` puts a client security floor into the tuple (CT-53, UP-B3d; IN-102).

The export carries a closure index per component and the compressed NAR of each store path (`nar/`, made once per NAR
hash in `~/.cache/whombat-releases/nar`, `--nar-cache DIR`); a box downloads only the paths it lacks (UP-X14). There is
no `--closures` any more: the full `nix-store --export` closures were for managers before 0.3.0 (UP-X23).

No ISO unless `--iso` (UP-X15). The ISO of a host build, later, from the source rev its `build.json` records (its
installed system checked to be the build's host; `build.json` stays as it is):

```sh
TMPDIR=~/.cache/wb-tmp release/build iso ~/.cache/whombat-releases/whombat-20260927.1   # iso/ and iso.json
```

`release/build host-path <host build.json> [--rev R]` only evaluates: this commit's host as that host release
was built (its id, its runtime, its manager version), printing both store paths and whether they are equal
(`release/ship build` uses it to tell a runtime-only release by itself, UP-X16, IN-156).

Output in `~/.cache/whombat-releases/<id>/` (`--out DIR` elsewhere):

| Path | What |
|---|---|
| `release/` | `tufrepo export-release`: `release.json` (`v: 2`: id, tuple, index metadata), `host.paths.json`, `runtime.paths.json` (the closure listings), `nar/<narhash>.nar.zst` (the blobs, hard links into the cache), `SHA256SUMS` (the top-level files) |
| `iso/`, `iso.json` | with `--iso` or `release/build iso`: `whombat-installer.iso` (dev: `whombat-installer-dev.iso`) and its `SHA256SUMS`; `iso.json` its file, store path, size, sha256 and system (host releases) |
| `tuple.template.json`, `tuple.json` | the tuple before and after the NAR hashes were filled |
| `build.json` | what was built: source commit, Whombat pin, class, tuple, each index's store path, NAR hash, closure size, paths and download size (builds before UP-X23 also `closures` and `artifacts`; before UP-X15 their ISO's store path, size and sha256 in `iso`) |

The tuple is filled from the bundle itself: `schemaWrites` = the number of migrations in `migrations/compat.json`,
`schemaReads.min` = the position of its `runtime.readsFrom`, the session protocol `{major*1000, major*1000+minor}`
from the server bundle, host ABI 1 (the flake's `hostAbi`). The script refuses the stand-in runtime, a manager or
runtime outside the host closure, and a toplevel whose `selfFactoryRelease` isn't the id.

The ISO is reproducible: `nix build --rebuild` of the same commit and id gives the same bytes (checked for
`pve-dev-20260927.1`, V-63), so `iso.json`'s sha256 can be checked against a rebuild.

Old folders go by themselves: whombat-ops `candidate` prunes after every run that ended well, and `release/ship prune
[--dry-run]` does it by hand (skipped while a candidate or other heavy work holds its lock). What every release Beta or
Production lists needs stays, with the build before each, the newest 10, anything changed in the last day and the host
of all of these; ISOs stay only for Production's two newest and Beta's newest (`promote` builds one again when it has
none); the `nar/` cache drops the blobs no folder links any more (`harness/src/ship/prune.ts`, IN-863).

## Publish: Beta, then Production

Every box reads the GitHub repository's channels (releases.whombat.com, LNK-20…LNK-27): Beta is the `development`
role, Production the `production` role (ONE-03). Publishing needs the publisher's clone of whombat-releases and its
token (`release/github/whombat-releases/SETUP.md`); no key leaves it:

```sh
tufrepo gh-publish --dir "$WHOMBAT_RELEASES_DIR" --release-dir ~/.cache/whombat-releases/whombat-20261120.1/release   # Beta
tufrepo gh-promote --dir "$WHOMBAT_RELEASES_DIR" --release whombat-20261120.1                                      # Production
```

- `gh-publish` uploads the release's blobs and files as release assets, then signs the `development` role and pushes
  it; the repository's workflow signs snapshot and timestamp on that push. It refuses a release that doesn't sort after
  Beta's newest (`--allow-downgrade-from <ids>` for a custody rollback).
- `gh-promote` lists a Beta release in Production unchanged (the same files), signed with the online production key
  (ONE-05); nothing is uploaded again.
- **Publish before anyone installs the ISO.** At its first boot the box looks its release up in TUF (`whombat-manager
  provision --factory-release`, `whombat-update-helper seed-factory`); a release that isn't there leaves the manager
  unprovisioned (it takes no updates) until the box is reinstalled.
- A box checks its channel about every hour and takes its newest release; there are no rollouts or waves.

## The installer download (ENV-22, PI-27)

After a release reaches Production (`promote`), its ISO goes on the download site under its version, the next one
after the version `installer/latest.json` names: `whombat-installer-v0.12.iso` and its `.sha256` at the root of the
site, then `installer/latest.json`, then every older installer is removed from the bucket (6 minutes later, once the
website's cache can't name it any more). The site holds one installer, and only a Production release's. Files are
compared by digest (PI-26): another file under the version's name is refused, and `latest.json` waits until the site
serves both files as they are here. `--version v1.0` sets a higher version by hand, on John's word. Nothing is
uploaded without a task that asks for it.

```sh
release/build iso ~/.cache/whombat-releases/whombat-20261120.1          # iso.json, iso/whombat-installer.iso
export WHOMBAT_INSTALLER_BUCKET=<bucket> WHOMBAT_INSTALLER_BASE_URL=https://<public domain>
release/upload-iso ~/.cache/whombat-releases/whombat-20261120.1 --production --dry-run   # what it would send
release/upload-iso ~/.cache/whombat-releases/whombat-20261120.1 --production
curl -sf "$WHOMBAT_INSTALLER_BASE_URL/installer/latest.json" | jq .
```

## Afterwards

- `nix-store --export` streams of a host are ~4.8 GB; delete `~/.cache/whombat-releases/<id>` once published and the
  ISO is uploaded (`build.json` is the record; keep it with the release notes). Its `nar/` holds hard links only: the
  blobs stay in `~/.cache/whombat-releases/nar` (one per NAR hash, ~2.5 GB for a whole host closure, a few tens of MB
  more per release), so the next export compresses only new paths. Prune that cache by hand when it grows; nothing
  else refers to it.
