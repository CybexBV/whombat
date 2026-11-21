# Delta updates, ISO on demand, automatic runtime-only releases (UP-X14…UP-X17)

John, 2026-10-02: “How can we improve appliance builds (new updates / releases)?” → “Implement the suggested
improvements fully.” Decisions: `docs/decisions/updates.md` UP-X14…UP-X17. This file is the build spec.

## Why

Measured on `pve-20260930.3 → pve-20261001.1`:

| | Downloaded today | Not on the box yet | zstd |
|---|---|---|---|
| host release | 4,834 MB (`host.closure`, uncompressed `nix-store --export` of the whole closure) | 82 MB, 24 of 1,118 paths | ~19 MB |
| runtime release | 371 MB (`runtime.closure`) | 37 MB, 1 of 67 paths | ~5 MB |

The box downloads the full closure, the helper copies it (root-owned), then `nix-store --import` skips what is
valid. Staging needs ~3× the closure (the `no_space` failures). Each host build also writes two full closures and
builds two ISOs (PROD + DEV twin), which no update uses.

## 1. Closure index + per-path NAR blobs (UP-X14)

### Repository layout

- **Index target** per component (host generation, runtime bundle, provider bundle): a TUF target, e.g.
  `host/<version>/whombat-host.index.json`, `runtime/<version>/whombat-runtime.index.json`,
  `provider/<name>/<version>/provider.index.json` (consistent-snapshot name `<dir>/<sha256>.<base>` like every
  target). Custom metadata (strict, `trust.IndexMeta`):

  ```json
  {"whombat": {"kind": "closure-index", "of": "host-generation", "version": "pve-20261002.1",
    "storePath": "/nix/store/…-nixos-system-whombat-…", "narHash": "sha256:<hex>", "closureSize": 4833491232,
    "managerStorePath": "/nix/store/…-whombat-manager-…", "provider": "", "paths": 1118, "downloadSize": 2648009477}}
  ```
  `managerStorePath` only for `of: host-generation` (required there), `provider` only for provider bundles.
  `paths` and `downloadSize` (sum of fileSize) are informational.

- **Index content** (canonical JSON, `trust.ClosureIndex`):

  ```json
  {"v": 1, "of": "host-generation", "storePath": "…", "narHash": "sha256:<hex>", "compression": "zstd",
   "paths": [{"storePath": "…", "narHash": "sha256:<hex>", "narSize": 123, "references": ["…"], "deriver": "…",
              "fileSize": 45, "fileHash": "sha256:<hex>"}, …]}
  ```
  `paths` is the whole closure of `storePath` in **import order** (every reference is the path itself or earlier),
  deterministic (topological, ties by store path). The root is in it with the tuple's narHash. `deriver` may be "".

- **Blobs**: not TUF targets; content-addressed, verified through the signed index. The zstd-compressed NAR of a path
  (`nix-store --dump`), stored at `targets/nar/<fileSha256hex>.<narSha256hex>.nar.zst`. As a download unit it is
  `trust.Artifact{Target: "nar/<narhex>.nar.zst", Length: fileSize, Hashes: {sha256: fileHashHex}}`, so
  `tufclient.RemotePath` gives exactly that file name and `Downloader` works unchanged. One blob per NAR hash in a
  repository: publishing reuses an existing `nar/*.<narhex>.nar.zst` (its sha256 and size come from its name and
  `stat`; the repository wrote it after verifying it) and writes the index with that file's hash.

- **Legacy closure artifacts** (`host.closure`, `runtime.closure`, format `nix-export`) stay as they are and are
  optional from now on (see 4). Old managers/helpers (< 0.3.0) only understand them; they skip targets of kind
  `closure-index` (their `component()` filters by kind) and never fetch blobs.

### Release directory (what `tufrepo export-release` writes)

`release.json` becomes `v: 2` when it has indexes (v1 stays readable):

```json
{"v": 2, "releaseId": "…", "tuple": {…}, "artifacts": [ …legacy, may be empty… ],
 "indexes": [{"target": "host/<v>/whombat-host.index.json", "file": "host.paths.json", "meta": IndexMeta}]}
```
`<component>.paths.json` is the closure listing (the index content without `fileSize`/`fileHash`, `v: 1`), and
`nar/<narhex>.nar.zst` holds the blobs (hard links into the build machine's cache, see below). `SHA256SUMS` covers
the top-level files only (not `nar/`): the upload may leave out blobs the repository already has.

`tufrepo export-release … [--closures both|index|full] [--nar-cache DIR]`:
- `both` (the CLI default, so existing callers and the VM gates keep working), `index` (no legacy streams), `full`
  (today's output, v1).
- `--nar-cache DIR` (default `$XDG_CACHE_HOME/whombat-releases/nar` → `~/.cache/whombat-releases/nar`): blobs are
  compressed once per NAR hash across all releases. Path facts come from `nix path-info --json --recursive`
  (narHash in any of Nix's encodings → `sha256:<hex>`, narSize, references, deriver); only paths missing in the cache
  are dumped (`nix-store --dump`, in parallel), hashed while compressing, and refused when the dump's NAR hash/size
  differ from path-info's. zstd via `github.com/klauspost/compress/zstd`, a level around zstd 15–19 equivalent
  (`SpeedBestCompression`), one encoder per worker; a blob is written to `.tmp` and renamed.
- With `--reuse-host` the host index (and legacy host artifact) is left out: it must already be published.

### Publishing (`tufrepo publish-release`, repository side; DEV: `dev/publish-release`, PROD: `deploy.sh release`)

For every index in the release directory:
1. read and validate the listing: strict JSON, well-formed store paths/hashes, no duplicates, import order, closure of
   the root complete and equal to the listing, root narHash = tuple component's, closureSize = Σ narSize, host
   listing contains the manager;
2. for each path: reuse the repository's blob for that NAR hash, else take `nar/<narhex>.nar.zst` from the release
   directory and verify it **by decompressing** (bounded: output ≤ narSize, decoder window ≤ 128 MiB): NAR sha256
   and size must equal the listing's; copy it into `targets/nar/<filehex>.<narhex>.nar.zst` (tmp + rename);
   a path whose blob is neither here nor in the repository fails the publish, naming it;
3. write the index content (with each path's fileSize/fileHash) as the target; refuse different bytes under an existing
   index target path (as for artifacts).
Every check runs before the metadata is signed; blobs written before a failure are harmless (content-addressed).
`PublishResult` adds `blobsAdded`, `blobsReused`, `bytesAdded`.

`tufrepo nar-list --dir <repo>` prints the NAR hashes (hex, one per line) of the repository's blobs (for
`deploy.sh release` to upload only missing ones). `tufrepo features` prints `closure-index` (and future feature
names), one per line, so a caller can tell an old `tufrepo` on a host (unknown command → error).

### The box (manager ≥ 0.3.0, helper of the same host)

- `trust.Repo.Release(id)` resolves for each component the legacy artifact **and/or** the index target (same kind,
  store path, NAR hash, version; index `managerStorePath` = tuple manager). At least one per component, else
  `ErrNotApproved`. `trust.Release` gains `HostIndex`, `RuntimeIndex *Artifact` and `ProviderIndexes []*Artifact`
  (nil when absent); `Host`/`Runtime`/`Providers[i]` may be zero when only the index exists. Add helpers so callers
  don't branch everywhere (e.g. `rel.Units(host bool) []Unit` where a unit is legacy or index).
- `trust.ParseClosureIndex(b []byte, ia Artifact) (*ClosureIndex, error)`: verifies bytes against the index
  artifact (length, sha256), strict JSON, the same structural checks as publish step 1, `compression == "zstd"`,
  fileSize > 0, ≤ 65536 paths. `ClosureIndex.Blob(i) Artifact`.
- **Manager** (`update` engine, `tufclient`): when a component has an index, download the index (small), parse it,
  ask the helper which of its store paths are not valid (new typed helper op `missing-paths`, request carries
  `storePaths` ≤ 65536, each `trust.ValidStorePath`; read-only; the helper answers with the invalid subset via
  `nix-store --check-validity --print-invalid`), then `EnsureSpace` and download only those blobs (blob
  `Meta.ClosureSize` = narSize so `Required` counts the unpacked size). Components without an index use the legacy
  artifact exactly as today. Crash/restart safe: the Downloading phase re-plans idempotently. The journal's
  `ArtifactSHA256` keeps the index (and legacy) artifacts; blobs are not kept for current/known-good (they may be
  garbage-collected from staging once imported). Log one line per component: paths, missing, bytes to download.
- **Helper** stage op: for each unit in order (host, runtime, providers): legacy → today's code; index →
  `CopyVerified` the staged index into its work dir, parse it with the helper's own verified `Artifact`, then for each
  path in order: valid → skip; else its blob must be staged (`not_staged` naming the path otherwise) →
  `CopyVerified` (root-owned copy, fileSize/fileHash) → **pass 1** decompress, check NAR sha256 and size against the
  index → **pass 2** decompress into an export frame (`u64 1`, NAR, `u64 0x4558494e`, path, references, deriver,
  `u64 0`, then `u64 0`) piped to `nix-store --import` (activator `ImportNar`) → check validity → remove the copy.
  `ENOSPC`/`ErrNoSpace` → `no_space`; hash/size mismatch → `verification_failed`. Batching several small paths into
  one `--import` is allowed.
- The zstd decoder: `zstd.NewReader(r, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxWindow(128<<20),
  zstd.WithDecoderLowmem(true))`, output bounded by narSize+1.
- Version: `applianceVersion` 0.2.0 → **0.3.0** (flake.nix). “Manager ≥ `0.3.0-0`” means “understands closure
  indexes”. Keep UP-X09's ordering (dev builds `0.3.0-0.dev`).

## 2. Legacy closures only while a box needs them (UP-X17)

`release/ship build` chooses `--closures` per environment: `index` when every live box of that environment (PROD:
production control's device list, the same source as UP-E6's check; DEV twin: DEV control's devices) reports a manager
≥ `0.3.0-0`, else `both`; unreachable fleet → `both`. `--closures both|index|full` overrides. `build.json` records the
choice and why. `promote-prod` refuses a build without legacy closures while a live production box runs a manager
< `0.3.0-0` and names the boxes (`--allow-old-managers` would only make sense with an override; don't add it).

## 3. ISO on demand (UP-X15)

- `release/build-proxmox` builds no ISO unless `--iso`; `release/build-proxmox iso <out dir>` builds the ISO of an
  existing host build from its recorded source rev, checks its installed system is the build's host store path, and
  writes `iso/` + `iso.json` (file, storePath, sha256, size). `build.json` is not rewritten (records hash it).
- `release/ship iso <prod id> [--dev|--both]` runs that for the PROD build and/or its twin.
- `promote-prod` builds the PROD ISO first when a host release has none (before anything is published) and uploads it
  as today; `dev/devbox create|rebuild` builds the twin's ISO when missing. `release/upgrade-gates` builds its own ISO
  in Nix (unchanged). Code that read `build.json`'s `iso` reads `iso.json` first, then `build.json` (older builds).

## 4. Automatic runtime-only releases (UP-X16)

`release/ship build <id>` without `--reuse-host` decides by itself: it evaluates (no build) this commit's host toplevel
`outPath` as the newest published PROD release's host would have been built — `releaseId` = that host's version,
the Whombat input at that release's runtime pin (and runtime label) — and compares it with that host's store path.
Equal → only the runtime changed: a runtime-only release reusing that host (and the twin's host for DEV). Different, or
the evaluation fails → a host release. `--host` forces a host release; `--reuse-host <id>` stays. The decision and the
compared paths go into `build.json` and the notes.

## Not now

- Repository garbage collection of unreferenced blobs and old closures (`tufrepo gc`): the PROD repository is small;
  later.
- Production: the Hetzner host needs the new `tufrepo` (`deploy.sh updates`) before the first PROD release with
  indexes; `deploy.sh release` checks `tufrepo features` and says so. PROD steps still need John's yes.

## Results on DEV (2026-10-02)

| | Before (`pve-20261002.1`, other session) | `pve-20261002.2` (both; old manager takes the closures) | `pve-20261002.3` (index only, manager 0.3.0) |
|---|---|---|---|
| `release/ship build` (PROD + twin) | ~15–25 min (two ISOs, two 4.8 GB exports) | 3 min 3 s | 2 min 16 s |
| New blobs published to DEV | — | 1,114 (2,527 MB, first fill) | 49 (590 MB; 576 MB of it the recovery UKI, fixed by NX-134) |
| Publish → box Verifying | — | 3.5 min | 2 min |
| Publish → Healthy | 17 min (1,021 s) | 17.5 min (1,051 s, 9 migrations) | 14.5 min (871 s) |

**Follow-up (MG-61):** the box's own journal (read from a ZFS clone of its disk) showed `.3` Healthy 2 min 7 s after
the assignment and the runtime-only `pve-dev-20261002.4` after 52 s; the rest was control's device record waiting for
the next 15-minute status.report. With MG-61 (a status.report soon after every transition; publish-dev follows the
rollout's progress) `pve-dev-20261002.5`, a host release, went from publish to Healthy in **2 min** (publish-dev
148 s in all, smoke included). It added 50 blobs (590 MB) once more because NX-134 gave every Go binary a new store
path; the next host releases carry only what changed.

Before that was understood: on `.3` the box rebooted 2 minutes after the publish and then
took ~12 minutes after boot before it reported Healthy (`uptimeS` against control's `lastSeenAt`). That startup is the
next thing to measure (it needs timings from the box: the manager's verify evidence or a debug shell on the DEV box).
NX-134 makes the next host release carry every Go binary once more (new source sets), and later manager-only host
releases a few MB.
