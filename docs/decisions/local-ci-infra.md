# Local CI worker infrastructure (2026-09-29)

The user keeps GitHub source and PR hosting and moves CI computation and build storage
to `thetitan`. The implementation is in `scripts/ci/infra/`; workflow and artifact-service
decisions are recorded with their respective workstreams.

| ID | Decision | Reason |
| --- | --- | --- |
| LCI-I01 | One repository-scoped GitHub Actions runner in a dedicated Ubuntu 24.04 Incus VM for each of Whombat, contracts, API, app, relay and appliance. The owner account is a GitHub user, so registration uses repository endpoints. | Reuses GitHub scheduling/checks while isolating Docker, ports, files and credentials between repositories and from development services. |
| LCI-I02 | Contracts/API/relay have 4 vCPU/6 GiB, runtime/app 4 vCPU/12 GiB, appliance 8 vCPU/16 GiB, one job per worker. Each guest has 2 GiB emergency swap; ordinary disks are capped at 100 GiB, appliance at 200 GiB. | Total 28 vCPU/58 GiB leaves room for existing services. Runtime parallel TypeScript and app visual jobs exhausted the initial 6 GiB bound; their limits increased from observed failures. |
| LCI-I03 | Bootstrap one unregistered template, verify no runner credentials exist, clean cloud-init identity, stop and clone it. Provisioning manages only marked instances in a dedicated wb-ci project. | Avoids six identical toolchain installations and prevents accidental modification of unrelated instances. Registration tokens never enter the template. |
| LCI-I04 | A checkout is cleaned before and after jobs; caches, toolchains and artifacts are separate. Temporary files use the guest disk. | Warm dependencies improve feedback time without reusing an unchecked checkout or consuming host `/tmp` inodes/RAM. A persistent VM is still a trusted-job boundary, not an ephemeral security boundary. |
| LCI-I05 | Node, Go, runner and Nix archives have committed versions/checksums; pnpm, staticcheck and Playwright versions are pinned. Docker services use the guest daemon. | Makes worker provisioning reviewable and avoids host Postgres port collisions. Existing GitHub action caches/artifact uploads must be removed separately to make storage local. |
| LCI-I06 | Appliance gets its own persistent Nix store, Nix 2.26.3, KVM/QEMU, PostgreSQL 17 binaries and backup-test dependencies. Nix uses at most two builds with four cores each. | Native NixOS VM tests can run on the Debian host through nested KVM without exposing the host Nix daemon or its default 64-core build settings. |
| LCI-I07 | Artifact helper/data mounts and read-only private runtime fetch credentials are installed after cloning; no release signing keys in ordinary workers. | Keeps the reusable template free of private credentials and scopes retained output access to each repository. |
| LCI-I08 | Enable unprivileged user namespaces only inside CI guests for bubblewrap integration tests. | Ubuntu's default AppArmor restriction blocks the application's managed-sandbox tests; guest isolation preserves the host's configuration. |
| LCI-I09 | A dedicated persistent host firewall unit manages only wbci0 and Whombat chains: public IPv4 egress/return traffic, host DNS/DHCP, no private/link-local/Tailscale/IPv6 access. | Keeps the workers away from host services and other private networks while allowing downloads. Docker's host forwarding policy otherwise blocks a new bridge. |
| LCI-I10 | Copy the existing licensed Android SDK components into the app VM, pin platform 36/build-tools 36.0.0/NDK 27.1.12297006/CMake 3.22.1, keep Gradle caches and Java 21 there. | Runs the authored extended Android APK checks locally without exposing the developer home or installing an unnecessary emulator. |
| LCI-I11 | Use GitHub's service supervisor with explicit graceful listener shutdown, and OOMPolicy=continue. | A raw run.sh restart orphaned the server session lease, and an initial compiler OOM stopped the full runner. Fail the job while keeping reporting available where possible. |
| LCI-I12 | Daily idle guest maintenance removes old Docker/temp data; image/pnpm/Nix GC occurs under disk pressure. Artifact retention stays in the separate host service. | Bounds disposable storage without clearing warm caches on every job or touching retained releases. |
| LCI-I13 | Import and root exact existing Nix closures for the backup test MinIO/sshd/restic tools; configure their explicit paths. Install DejaVu fonts in the base. | Exercises backup destination tests without silent missing-tool skips and matches the established visual baseline's system monospace fallback. |

Infrastructure verification: shellcheck, shell syntax, mocked provisioning/path guard
checks, then real guest PostgreSQL/KVM/toolchain smoke checks and each repository's
GitHub workflow. The Android SDK is installed for the app's extended checks; native
ARM and iOS require suitable additional workers.
