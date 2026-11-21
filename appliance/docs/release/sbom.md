# SBOM, licenses, provenance and vulnerability scan

`release/sbom` produces, for the components of a commit, a CycloneDX software bill of
materials per component, a merged license inventory with flags, a provenance record, and a vulnerability scan
with triage. This page says how to run it, what it covers, what the 0.5.2 release candidate's results are, and
what it doesn't cover.

Current output: `release/out/2026.09.25-dev.4/` — the **0.5.2 release candidate** (`productVersion`
2026.09.25-dev.4, release id `rt-2026.09.25-dev.4`, contracts 0.5.2), run `20260925T212352Z` on 2026-09-25 from
fresh clean clones (build run `2026-09-25-2123`).

## Run it

```sh
TMPDIR=~/.cache/wb-tmp release/sbom            # this checkout's commit: clean clones, build, SBOMs, scans, summary
release/sbom --rev <commit> --name <candidate>  # a release's commit, named after its candidate
release/sbom --pins <file>                      # a pins file as it is: an earlier release's candidate manifest
release/sbom --scratch <dir>                    # reuse a kept `manifest/build --keep` scratch at the same commits
release/sbom --no-android --no-nix --no-scan    # subsets
```

Which commit of which component is inventoried are the pins. For a commit of this repository they are the component
list, `manifest/components.json`, with that commit filled in (`manifest/pins-at`): the runtime, the app, the contracts,
the appliance's Go programs and the hosts service at the commit itself, and control and the relay at the commits the
maintainers' release records name (`--cloud <commit>` names another).

Needs: nix (flakes), pnpm 12, Go, Node 24, git; for the Android part `ANDROID_HOME` (default `~/Android/Sdk`) and
JDK 21; network for the nixpkgs binary cache, the Gradle plugin portal and the vulnerability databases. It never
pushes, publishes or signs anything. It rewrites nothing in the repository except `release/out/<version>/`
(`manifest/build` writes its report beside the pins, in the run's work directory; a report the repository holds is
restored byte for byte, and the fresh one is kept in the work directory and in `provenance.json`).

## What it does

1. **Clean clones built like the release.** `manifest/build --keep --no-manifest`: a fresh `git clone --no-local`
   of each repository at the pinned commit, frozen lockfiles, the pins' build commands. The script then checks
   every scratch clone is at exactly the pinned commit with no modified tracked file.
2. **SBOMs (CycloneDX 1.6 JSON), one generator per ecosystem:**

   | Component | Generator | Files in `sbom/` |
   |---|---|---|
   | whombat-contracts @25e23ea (contracts-v0.5.2) | `pnpm -r sbom`; `cyclonedx-gomod mod -licenses` for the Go bindings | `whombat-contracts`, `whombat-contracts-go` |
   | whombat-runtime (Whombat @52c3ff2, managed/hardening) | `pnpm -r sbom` | `whombat-runtime` |
   | whombat-app @d89ddcb | `pnpm -r sbom`; `pnpm --filter @whombat/web sbom --prod` (the hosted UI); `pnpm --filter @whombat/mobile sbom --prod` (the phone app's JavaScript); CycloneDX Gradle plugin 3.4.1 on `:app` `releaseRuntimeClasspath` after `expo prebuild` in the scratch clone (Android native libraries), via an init script — no repository change | `whombat-app`, `whombat-app-web-hosted`, `whombat-app-mobile-js`, `whombat-app-android` |
   | control @a1d74d1 | `pnpm sbom` | `whombat-api` |
   | the relay @2dc2d8a | `cyclonedx-gomod app -licenses -std` per binary the pins ship | `whombat-relay-{relay,relay-loadgen,dev-ticket}` |
   | appliance Go @62eb943 (manager, helper, recovery manager, tufrepo, backup, snapd, provision, fake control) | same | `appliance-*-<binary>` |
   | NixOS closure @62eb943 `#appliance-toplevel` (runtime closure, 733 components) | `sbomnix` (+ SPDX 2.3 JSON) | `nix-appliance-toplevel.{cdx,spdx}.json` |
   | provider CLIs `#whombat-provider-{codex,claude}` | `sbomnix`; source URL and fixed-output hash from `nix eval` into `provenance.json` | `nix-whombat-provider-*.{cdx,spdx}.json` |

   pnpm SBOMs mark dev dependencies with `scope: excluded`; the summary calls those “dev”, everything else
   “shipped”. In the full-workspace SBOMs “shipped” also covers workspace tooling packages; the `-web-hosted`,
   `-mobile-js` and Android SBOMs are the precise shipped sets of those apps.
3. **Vulnerability scans:** grype (every SBOM except the Nix closure), osv-scanner (every non-Nix SBOM),
   govulncheck `-mode binary` (every shipped Go binary; symbol-level, so it says whether vulnerable code is
   linked), and `vulnxscan` (sbomnix's Nix-aware scanner: vulnix + grype + OSV) on the NixOS closure.
4. **Summary** (`release/lib/summarize.ts`, no dependencies): `licenses.{json,md}` classified by
   `release/policy/licenses.json`, `vulnerabilities.{json,md}` annotated by `release/policy/triage.json`,
   `provenance.json`, and `SHA256SUMS` over the output.

### Tools and versions (0.5.2 RC run)

All from the appliance's pinned nixpkgs `c508844df6c28fa6dabc1b6af70f3ccbd65c5201` (nixos-26.05, flake.lock of
appliance @62eb943), except pnpm (the version the repositories pin) and the Gradle plugin:

| Tool | Version | Used for |
|---|---|---|
| pnpm | 12.3.4 (`pnpm sbom`) | JS/TS workspaces |
| cyclonedx-gomod | 1.10.0 | Go modules and binaries |
| CycloneDX Gradle plugin | 3.4.1 (`org.cyclonedx:cyclonedx-gradle-plugin`, Gradle 9.3.1 of the app) | Android |
| sbomnix / vulnxscan | 1.7.6 | NixOS closure and provider bundles |
| grype | 0.112.0, DB schema v6.1.9 built 2026-09-25T06:31:49Z | vulnerabilities |
| osv-scanner | 2.3.3 (osv.dev at scan time) | vulnerabilities |
| govulncheck | 1.3.0 (vuln.go.dev modified 2026-09-24T20:07:49Z) | Go reachability |
| host | Node v24.18.0, Go 1.26.8, nix 2.26.3 | builds |

Nix store paths of each tool are in `provenance.json` `tools`. Tried and not used: syft 1.44.0 and osv-scanner's
own lockfile reader read only 9 of the 166 packages in a pnpm 12 lockfile (v9 with a config-dependencies
document), and cdxgen 11.10.0 failed to parse it; `pnpm sbom` reads the installed store and is complete.

## Provenance

`provenance.json` records, per component: repository, remote, ref/tag, **commit**, version, whether it was a
clean clone, the exact build commands from the pins (argv, cwd, env), each step's exit code and duration, the
vendored contracts version, and every artifact's **sha256** (source tarballs, binary tarballs, the hosted web
bundle, the contracts release files with a byte-for-byte comparison against the published `SHA256SUMS`). It also
records the pins file digest, the builder host toolchain, the Nix flake reference and store paths of the NixOS
closure and the provider CLIs (with their upstream URL and fixed-output hash), the SBOM files with their digests
and generators, and the manifest's placeholders.

Reproducibility, as measured: the contracts npm tarballs and schema tarball rebuild byte for byte; the contracts
**Go tarball does not** (`whombat-contracts-go-0.5.2.tar.gz` differs on every rebuild; consumers vendor the
published digest). Go binaries are built with `-trimpath` and `CGO_ENABLED=0` but their reproducibility across
hosts was not tested. The runtime Nix closure is not built yet (pins placeholder), so the runtime is inventoried
from its pnpm workspace rather than from the closure the appliance would run.

No build attestation is signed: provenance is a record, not an in-toto/SLSA attestation. Release custody signs
TUF targets over the tuple (`updates-release-signing.md`); CI attestation is an open item.

## License inventory (0.5.2 RC)

Full tables: `release/out/2026.09.25-dev.4/licenses.md`. Shipped components per SBOM range from 5 (contracts Go)
to 733 (NixOS closure). Flagged shipped components (deduplicated across SBOMs): **218**.

| Category | Count | What it is | What it means (requires qualified review) |
|---|---|---|---|
| strong-copyleft | 117 | GPL-family packages in the NixOS closure (kernel, coreutils, bash, git, gnupg, cryptsetup, …; Perl modules whose nixpkgs meta lists “Artistic-1.0; GPL-1.0-or-later”, counted conservatively as both) | Shipping the appliance image distributes them: corresponding source must be offered (GPL-2.0 §3 / GPL-3.0 §6). Nix makes the exact sources derivable from the flake; a written offer or a source mirror for the image is still needed. None are linked into Whombat's own programs. |
| weak-copyleft | 38 | LGPL/MPL libraries (glibc, systemd parts, gnutls, libgcrypt; `web-push` MPL-2.0 in runtime and control; `lightningcss` MPL-2.0 in the mobile JS build tooling; `github.com/opencontainers/go-digest` CC-BY-SA-4.0 docs licence in the manager) | Keep them as separate, replaceable libraries (dynamic linking in Nix; Go links go-digest statically — its code is Apache-2.0, the CC-BY-SA-4.0 comes from its docs; confirm). MPL: file-level source availability for modified files (none modified). |
| non-osi | 17 | Android: Google Play services, Firebase interop and ML Kit barcode scanning under the “Android Software Development Kit License” / “ML Kit Terms of Service”; `openssl-static` labelled “Dual OpenSSL and SSLeay” | Google terms bind the app publisher (use and redistribution terms; ML Kit terms also cover data use). Needed for FCM push (AP-29) and QR scanning (AP-31). Review before store release. |
| proprietary | 4 | `whombat-provider-claude` 2.1.278 and `whombat-provider-codex` 0.157.0 in the NixOS closure (fetched by hash, unmodified, `nix/packages/providers.nix`); `@anthropic-ai/claude-agent-sdk` and `…-linux-x64` 0.3.278 as runtime npm dependencies (“SEE LICENSE IN README/LICENSE.md”; the linux-x64 package bundles the Claude Code binary) | Redistribution in the image and use by customers are governed by Anthropic's Commercial Terms and OpenAI's terms: blockers X-01/X-02. Note the runtime ships the Claude Agent SDK package even though managed mode refuses SDK + subscription auth. |
| first-party | 42 | every `@whombat/*` package, the Whombat Go modules, Whombat Nix packages | **Licences declared (2026-09-26, D-01 resolved):** the four closed repositories (Whombat, control, the relay, the appliance) carry a proprietary `LICENSE` (“All rights reserved … No licence is granted”, wording marked draft for legal review) and `"license": "UNLICENSED"` in every `package.json` (LC-19); whombat-app and whombat-contracts are PolyForm Strict 1.0.0 with a security-research permission (SR-02). Classification is unchanged: `first-party` comes from annotations in `release/policy/licenses.json`, never from the licence string, so `UNLICENSED` rows stay first-party. The next SBOM run shows the declared licences. |
| unknown | 0 | — | Nix outputs without nixpkgs meta and local Android modules were resolved by explicit, reviewable annotations in `release/policy/licenses.json` (each says why). |

Also: 422 `not-applicable` rows in the NixOS closure are files the NixOS module system generates (units,
configuration), not packages.

Observations for the appliance owners (not license problems): the closure contains Perl with LWP, `nano`,
`man-db`, `nixos-build-vms`, `nix` and the nix-daemon socket, and openssh (client only; no sshd unit, NX-10).
Each adds attack surface and advisories; NX-03 says the device never builds or evaluates, which the nix-daemon's
presence doesn't contradict but does not need either.

## Vulnerability scan (0.5.2 RC)

Full table: `release/out/2026.09.25-dev.4/vulnerabilities.md`. 177 finding rows (one per SBOM × advisory),
all triaged; nothing was fixed in code (report only).

| | Critical | High | Medium | Low | Unknown |
|---|---|---|---|---|---|
| rows | 39 | 62 | 57 | 7 | 12 |

By triage: not-affected 85 · under-investigation 70 · fix-planned 7 · false-positive 12 · affected 1 · not-shipped 2.

### Triage notes (non-Nix: 24 distinct advisories)

| Advisory | Where | Decision | Why (evidence) |
|---|---|---|---|
| GO-2026-5970 (CVE-2026-56852) x/text infinite loop, fixed v0.39.0 | **whombat-backup**: x/text v0.36.0, `unicode/norm` Span/Properties/Transform **linked** (govulncheck) | **affected** — bump x/text ≥ v0.39.0 in the appliance go.mod; class 2 update | a local DoS of the backup service if attacker-influenced strings (e.g. workspace file names) reach normalization |
| same | snapd, manager, helper, recovery manager, tufrepo, provision, fake control (x/text v0.36.0, symbol not linked) | fix-planned with the bump | govulncheck: vulnerable symbols absent |
| same | contracts Go module (requires v0.14.0) | not-affected | a library's module graph; the relay links v0.40.0, the appliance v0.36.0 (above). Raise the floor in contracts' go.mod |
| 17 × x/crypto (GO-2026-5005…5033, 6303, 6354, 6355, 5932) v0.50.0, 7 of them Critical | manager, helper, recovery manager, tufrepo | not-affected (vulnerable code not in execute path) | all in `ssh`, `ssh/agent`, `ssh/knownhosts` or `openpgp`; govulncheck finds none of those symbols in the binaries; no SSH anywhere (NX-10). Bump to ≥ v0.56.0 with x/text anyway |
| GHSA-78wr-2p64-hpwj, GHSA-gwrp-pvrq-jmwv commons-io 2.6 | Android release APK, via expo-document-picker 57.0.2 (`gradle dependencyInsight`) | under-investigation (W2-APP) | inputs are files the user picked; needs a code read, or a Gradle constraint to ≥ 2.14.0 |
| GHSA-4jrv-ppp4-jm57 gson 2.8.6 | Android release APK, via expo-log-box | under-investigation (W2-APP) | developer error overlay fed by the local bundler; confirm inert in release, or constrain ≥ 2.8.9 |
| GHSA-w5hq-g745-h8pq uuid 7.0.3 | app workspace / mobile JS set, via xcode ← @expo/config-plugins (`pnpm why`) | not-affected | prebuild-time tooling, not bundled by Metro; needs caller-supplied buffers |
| GHSA-67mh-4wv8-2f99 esbuild 0.18.20 | control, runtime (dev) | not-shipped | build tooling (drizzle-kit) only |

The relay, the hosted web UI and the contracts packages have **no findings**.

### Triage notes (NixOS closure: 93 rows)

- **false-positive (12):** six “git” CVEs are Jenkins Git plugin advisories matched by product name; three dbus
  CVEs matched version “1” parsed from the generated `dbus-1` directory (dbus is 1.16.2); three historic
  distribution-specific openssh advisories.
- **not-affected (14):** binutils (only in the closure via lanzaboote's `lzbt`, which runs objcopy on trusted UKI
  inputs; `nix why-depends`); gcc CVE-2023-4039 (AArch64 code generation; the image is x86_64).
- **under-investigation (67):** real upstream packages at the pinned nixos-26.05 revision (2026-09-24): glibc,
  gnutls, perl, unbound (library only: no unbound daemon runs; linked by gnutls), zlib, sqlite, libmicrohttpd
  (linked by systemd), openssh client, jq, patch, p11-kit, libcap, libxml2, nghttp2, libusb, busybox, dash, cpio,
  gnupg, ada. Scanners match versions and ignore nixpkgs patches. **Action (W2-NX):** bump the nixos-26.05 pin,
  rescan, then decide per CVE with the package's patches and exposure (no inbound listeners, T9). Critical rows at
  the pin: glibc CVE-2026-5450, gnutls CVE-2026-33845/42010, perl CVE-2026-13221/4176/8376, unbound
  CVE-2026-81642/82717, zlib CVE-2026-27820 — **not verified** beyond the scanners' match.

## What is not covered

- **iOS app** — not built (N-01).
- **Runtime Nix closure and its Node.js** — not built (pins placeholder); Node 24 and the runtime's native modules
  as the appliance will run them are therefore not in any SBOM. The runtime's npm dependencies are.
- **Control's OCI image** (built by its infra) and the relay image — only their Go/npm dependencies are covered,
  not base-image OS packages.
- **Provider CLI internals** — the Codex and Claude binaries are opaque vendor artifacts; their SBOM rows are the
  artifacts themselves (name, version, source URL, hash), not their bundled components.
- **Build-time Nix inputs** (`sbomnix --buildtime`) — only the runtime closure is inventoried.
- **Installer ISO and recovery UKI** as separate artifacts — the recovery tools are in the toplevel closure;
  the images themselves were not inventoried.
- **Signed attestations** (SLSA/in-toto) and **VEX/CSAF export** — not built.
- License classification is automated from declared metadata; declared licenses were not verified against
  source files (no scancode-style scan).
