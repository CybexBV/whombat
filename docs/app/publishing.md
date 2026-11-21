# Publishing the app

The app is built from this repository wherever it is published; nothing vendors a build of it any more
(`docs/decisions/one-repo.md` OR-08). Its version is `apps/web/package.json`'s `version`, and `app-vX.Y.Z` tags the
commit a version was published from.

| What | Built by | From |
|---|---|---|
| The box's own page (the page browsers open on its local-network address or Tailscale name; Whombat hermes-engine.md HE-50, direct-connection.md DC-08; hermes-engine-app.md AP-5327) | the appliance's Nix runtime package, `pnpm --filter @whombat/web build:prod` (`VITE_WHOMBAT_TARGET=box`, no fixtures) | the Whombat commit the appliance pins |
| The hosted app (app.whombat.com, dev.whombat.com): `pnpm build:web:hosted` | control's deploy (`infra/hetzner/deploy.sh`) | the newest `app-vX.Y.Z` tag, or a ref you name |
| The Feedback widget's embed tree: `pnpm build:embed --control-url …` | control's deploy, the appliance's dev stack | the same |
| The Android APK: `pnpm --filter @whombat/mobile publish:apk --env dev\|prod --dir <control's DOWNLOADS_DIR>` | by hand on the build machine (release key, Firebase config) | a checkout of the published commit |
| The iOS app | a Mac (`apps/mobile/README.md` “iOS”) | a copy of a checkout |

## Releasing a version

1. Set `version` in `apps/web/package.json`, commit, and tag the commit `git tag -a app-vX.Y.Z -m "app X.Y.Z"`. A
   phone installs only a higher `versionCode`, so publish an APK only from a higher version.
2. Publish what the version is for: the APK, the hosted app through control's deploy.
3. A record of the box's page as one file, when wanted: `pnpm app:release` (from a clean tree; `--allow-dirty` for
   local trials, `--skip-build` to package the current `apps/web/dist`)
   writes `dist-release/app/<version>/`:

   | file | contents |
   |---|---|
   | `whombat-app-dist-X.Y.Z.tar.gz` | `web/` (the box's page: `index.html`, `assets/…` with `.br`/`.gz` siblings, icons, `sw.js`) |
   | `SHA256SUMS` | sha256 of the archive (`sha256sum -c` format) |
   | `RELEASE.json` | version, commit, contracts version, `target: box`, archive hash, size and entry count |

   The archive is deterministic: a minimal ustar with directories and files sorted by path, every mtime set to the
   commit time, uid/gid 0 (`root`), modes 0755/0644, gzip level 9 with no name, mtime 0 and OS byte 255. The same
   commit and toolchain produce the same bytes. It refuses an existing `dist-release/app/X.Y.Z/` (immutable).

The operator panel is not built here: it lives in control's repository (`admin/`), which builds and deploys it with control
(`docs/decisions/public-copy.md` PUB-13).

## The hosted build and the widget

The hosted app at app.whombat.com is a different build (`VITE_WHOMBAT_TARGET=hosted`, `pnpm build:web:hosted`) served
from the app origin with its own CSP; the Feedback widget is built on its own (`pnpm build:widget`).

### Build number and `version.json` (AP-259)

The web's build number (what `hello.client.buildNumber` carries and a box's client security floor compares, CT-53) and
Android's `versionCode` both come from the app's version in `apps/web/package.json`:
`major × 1 000 000 + minor × 1 000 + patch` (0.12.0 → 12000). Building a tag always gives the same number, with or
without git history; the deploy sets nothing (`VITE_WHOMBAT_BUILD_NUMBER` overrides it, digits only, for a local
trial). `VITE_WHOMBAT_BUILD` defaults to `<version>+<short commit>`, and to the version alone without git (the
appliance's build, so its output doesn't change with the commit).

Every web build writes `version.json` at its root, fixed at build time:

```json
{ "version": "1.0.0", "build": "1.0.0+1a2b3c4", "buildNumber": 1000000, "protocol": 2, "contracts": "1.0.0" }
```

`protocol` is the session protocol major the build speaks (`SESSION_PROTOCOL.major` of `@whombat/protocol`): a box on
another major refuses it and the page says who must update (HE-52, CT-1260). `contracts` is the version of the
workspace's `@whombat/protocol`. There is no API level or window any more.
