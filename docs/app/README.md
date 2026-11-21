# The apps

Whombat's clients, which were the whombat-app repository until it moved here (`docs/decisions/one-repo.md`): the web
app (`apps/web`), the Expo app (`apps/mobile`, Android first), the Feedback widget (`apps/widget`),
the shared client session and transport layer (`packages/client`), design tokens, avatars and brand
(`packages/{tokens,avatars,brand}`) and the visual tooling (`tools/visual`). This folder holds the app's own documents
and decisions (`decisions/`, AP- codes); paths below are relative to the repository root.

## Open source

The clients are open so anyone can check how Whombat handles their data. Start with
[the privacy and security model](privacy-and-security.md): what is end-to-end encrypted, what our servers
can and can't see, and what reading this code can't prove. The protocols and the claim ceremony are the contracts'
(`packages/protocol`, `packages/secure-channel`, `docs/contracts/`).

- **Licence:** copyright 2026 Cybex BV, free software under the GNU Affero General Public License, version 3 only
  (`LICENSE`, `AGPL-3.0-only`). You may use, study, change and share it; if you let people use a changed version
  over a network, you must offer them its source code too.
- **Report vulnerabilities privately:** `SECURITY.md` (security@whombat.com). Issues and pull requests are
  welcome; a pull request under the contributor agreement (`CONTRIBUTING.md`, `docs/legal/contributor-agreement.md`).
- Third-party licences: `THIRD_PARTY_NOTICES.md`. The name, logo, mascot and app icons: `TRADEMARKS.md` (a fork needs
  its own name and logo).
- Decision IDs in comments and docs (`AP-nn`, `CT-nn`, `MA-nn`, …) refer to internal design records that aren't
  published, and so do the design references the visual tooling compares against (`pnpm visual`,
  `pnpm ref:shot` don't run from the public mirror). `pnpm e2e:managed` runs against an in-browser fake.

## Development

```sh
pnpm install
pnpm check                       # biome + typecheck + unit tests (every package of the repository)
pnpm dev:web                     # web :5180 (+ widget watch): the box's page, its socket proxied to a local runtime
pnpm build:web                   # the box's own page (VITE_WHOMBAT_TARGET=box)
pnpm build:web:hosted            # the hosted app: dist-hosted/ with _headers (VITE_WHOMBAT_TARGET=hosted)
pnpm build:widget                # the Feedback widget, deployed on its own
pnpm visual                      # Playwright visual comparison against the HTML references (fixture mode)
pnpm e2e:managed                 # the hosted app's journeys against the in-browser fake world
pnpm --filter @whombat/web e2e:hosted   # the hosted build under its strict CSP, same fake world
pnpm e2e:box                     # the box's own page against the fake world's community box
pnpm app:release                 # the box's page as one checksummed archive (publishing.md)
ANDROID_HOME=$HOME/Android/Sdk pnpm --filter @whombat/mobile android:apk   # debug APK
# on-device secure-session harness: apps/mobile/scripts/device-harness/README.md
```

One transport, the end-to-end encrypted session (`@whombat/client/session`), three ways: through the relay, or straight
to the box on its local network or Tailscale name, which clients try first. Two web pages (`VITE_WHOMBAT_TARGET`):
`box` (default) is the page a box serves on its direct ways — it talks to its own origin's direct socket, no control;
`hosted` is app.whombat.com — the cloud account, then the box directly or through the relay (`VITE_WHOMBAT_CONTROL_URL`,
`VITE_WHOMBAT_RELAY_ORIGINS`; `VITE_WHOMBAT_FAKE=1` for the fake world). `VITE_FIXTURES=1` runs the burrow app on an
in-memory box serving the mock world; `VITE_FIXTURE_VOICE=ready` (or `gpu`, `downloading`, `failed`, `off`) gives that box
voice typing's fake speech service, so the composers' mic records and This Whombat shows VOICE TYPING. With `pnpm dev` (the runtime) running, `pnpm dev:web` opens its page at :5180 and
signs in on this machine with a name and an email (the runtime's development enrolment; `WHOMBAT_DIRECT_PORT`, else
the runtime's `PORT + 80`). A community box (`GET /v1/direct` says `edition: community`) has no relay or control: its
page claims it when nobody has (the four letters on its screen, the person's account, Tailscale with an optional login
server of your own), and the person's other devices come in with the links and QR codes it makes (`/add-device`).

The contracts (`@whombat/core`, `@whombat/protocol`, …) are workspace packages: the apps build against their sources.
The app's version is `apps/web/package.json`'s. Set `TMPDIR` if `/tmp` is small, and use free ports (`WEB_PORT`,
`WEB_VISUAL_PORT`, …) when other instances run. Third-party licence list: `pnpm notices` (`--check` to verify). Working in
public: `docs/decisions/public-copy.md`.
