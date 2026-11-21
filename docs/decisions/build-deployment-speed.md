# Build and deployment time

John asked for a 30% reduction in build and deployment time. The work is in the appliance's candidate, release
build and DEV startup; this repository supplies the runtime and both pages from one commit.

| # | Decision | Why |
|---|---|---|
| BDT-01 | **Measure the complete DEV candidate**, from starting to publication, a healthy stack and pushed notes. Compare fresh runtime revisions against candidate 0.261.1's 88 seconds; the target is at most 61.6 seconds. Home's next update check is outside the measurement. | A cached rerun or one faster step does not show how long delivering a change takes. |
| BDT-02 | **Prepare each input and artifact once.** Candidate preflight builds the versioned runtime that release/ship uses, with every pin check in the same Nix invocation. DEV startup shares a clone and install for matching app and runtime pins; the box and hosted pages build in separate output directories while services start. An explicitly reused host comes from its build record without evaluating a new NixOS system. | The runtime and apps share a repository, and their builds need no running services. Repeated work and independent preparation need not delay delivery. |
| BDT-03 | **Keep the delivery gates.** Pin, ABI, version and twin checks, backups, migration order and service health remain; publication waits for the completed build and healthy stack. | Faster delivery must still identify an invalid or broken release. |
| BDT-04 | **Compress the environment backup with at most four workers** using `pigz` when installed, with gzip as the fallback. Keep the default compression level, archive format, contents, exclusions and restoration. | The first fresh candidate took 64 seconds; the archive's 22.4 seconds outlasted the 16.8-second preflight. Bounded parallel gzip removes that delay without taking every core on the shared host. |

Implementation and measured results live in `appliance/docs/decisions/build-deployment-speed.md`; each run's
`summary.json` and logs are under the profile's `TMPDIR/rel-<version>/`.
