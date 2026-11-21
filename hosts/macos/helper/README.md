# Whombat Helper

A small Mac app that lets `whombat-agent` find things on the Mac's screen by name: list an app's buttons and fields,
press one, type into one, pick a menu item, bring an app forward, open a setting. The agent runs as root and has no
desktop session, so it can't do this itself; the helper runs inside the session of whoever is at the screen.

- Bundle id `com.whombat.helper`, name “Whombat Helper”, no Dock icon and no windows (`LSUIElement`).
- macOS 13 or later, Apple silicon and Intel (one universal binary).
- Installed by `install.sh` in `/Library/Application Support/Whombat/Whombat Helper.app` and started in every desktop
  session by the LaunchAgent `com.whombat.helper`.
- It needs **Accessibility** and nothing else. It never asks for it: the person (or the assistant, through the screen)
  switches it on in System Settings → Privacy & Security → Accessibility, which the `open accessibility` request
  opens. The pictures of the screen come from Screen Sharing, so it never needs Screen Recording.
- It listens on `/var/run/whombat-agent/ui/<uid>/helper.sock`, a folder the agent makes for the user at the screen;
  until it exists the helper waits. Each connection carries one JSON line in and one JSON line out. It answers
  **root only** (the agent): a program of the person's own would otherwise drive the Accessibility they gave Whombat
  Helper. The agent in turn talks only to the installed app's own process (the file the kernel says it runs, and its
  code signature).

The requests and answers are Whombat's `docs/implementation/macos/assignment.md` §2; what that left open is in this
repository's `docs/decisions/hosts.md` (HS-340 on).

## Layout

| Path | What |
|---|---|
| `Sources/HelperCore/` | Everything that can be tested without a screen: the socket, reading requests, writing answers, matching names and roles, limits. |
| `Sources/WhombatHelper/` | The app: Accessibility, keyboard and mouse events, running apps, opening things. |
| `Tests/HelperCoreTests/` | Unit tests (`swift test`). |
| `build.sh` | Tests, builds, signs, notarizes and zips it (below). |
| `VERSION` | The app's version (`CFBundleShortVersionString`). |
| `dist/` | The signed zip and its manifest, committed: the appliance's build copies them and can't build for macOS. |

## Trying it on a Mac

Xcode (or its command line tools) is all it needs.

```sh
cd macos/helper
swift test
./build.sh --unsigned                  # build/Whombat Helper.app, signed ad hoc: for this Mac only
open -n -a "$PWD/build/Whombat Helper.app" --args --socket /tmp/helper.sock
printf '{"v":1,"op":"status"}\n' | sudo nc -U /tmp/helper.sock          # only root is answered
printf '{"v":1,"op":"list","app":"TextEdit","limit":20}\n' | sudo nc -U /tmp/helper.sock
sudo "build/Whombat Helper.app/Contents/MacOS/WhombatHelper" --request '{"v":1,"op":"apps"}'
pkill -f 'WhombatHelper --socket /tmp/helper.sock'
```

Start it with `open` (or from its LaunchAgent), not from an SSH session: only a process of the desktop session sees
the session's apps, and macOS checks Accessibility for the app responsible for it (Terminal, when started from Terminal). Without Accessibility, `status` says
`"ax": false` and `list`, `press`, `set`, `type`, `menu`, `unlock` and `focused` answer `no_access`; `apps`, `focus`, `open` and
`windows` (the on-screen windows front to back, their owners and places, never their titles) still work, which is how
the agent answers macOS's password prompt that switches Accessibility on. An ad hoc signature changes with
every build, so a permission given to one is gone after the next; the signed build keeps it. macOS then still lists
“Whombat Helper” switched on while the new build has no access, so the agent's update and `install.sh` reset the
permission for such a build (`tccutil reset Accessibility com.whombat.helper`) and it shows up switched off.

`unlock` types the person's password into the lock screen for the agent: keys from inside the session open it for
good, while typed through Screen Sharing they are undone when Screen Sharing's last viewer leaves. Every key goes one at
a time, each only while the screen is still locked and the lock screen's password field still has the keyboard: whatever
takes the keyboard meanwhile gets nothing, and Return isn't pressed.

It logs each request's op and outcome (never names, values or typed text) to the unified log
(`log stream --predicate 'subsystem == "com.whombat.helper"'`) and to standard error.

## Building a release

Bump `VERSION`, then on the Mac that holds the signing keychain:

```sh
macos/helper/build.sh
```

It runs the tests, builds, signs, notarizes, staples, and writes `dist/whombat-helper-macos.zip` and
`dist/whombat-helper-macos.json` (`{"version", "sha256", "size", "team"}`), then scans the zip with
`scripts/scan-artifacts.sh` (`WHOMBAT_GUARDS_REQUIRED=1` and `SCAN_FORBID_FILE` as the maintainers' tools set them).
Commit both files.

Macs take a new version by themselves. The appliance signs the zip with the agents (`rackoon-sign manifest` with
`whombat-helper-macos.zip` among the names reads the version from the json beside it), and the hosts service sends
it to every Mac whose agent can take it, over the agent's own update stream. The agent checks the signature, the
bundle, `codesign` and the team (the installed helper's, or the json's `team`), swaps the app in, restarts it in each
desktop session and puts the previous one back when the new one doesn't answer within 2 minutes
(`docs/AGENT-PROTOCOL.md`, “Whombat Helper updates”). A version is never sent to a Mac that has the same or a newer
one, so bump `VERSION` for every build you ship.

## Signing

The helper is signed with the team's **Developer ID**, with the hardened runtime and a secure timestamp, and
notarized by Apple. macOS remembers the Accessibility permission for that signature, so it survives updates; an
unsigned or ad hoc signed helper would lose it with every new build. Notarization lets Gatekeeper open it.

The certificate's private key lives only in a keychain of the build's own,
`~/Library/Keychains/whombat-helper.keychain-db`; its random password is in `~/.config/whombat/helper/keychain.pass`.
The build unlocks it and hands it to `codesign` directly. It is never added to the keychain search list: Xcode would
then choose it for other builds in other sessions and fail while it is locked. Notarization uses the team's App Store
Connect API key in `~/.config/whombat/ios` (`asc.json` with `keyId` and `issuerId`, and `AuthKey_<keyId>.p8`), or
`$WHOMBAT_ASC_DIR`.

Only the team's **Account Holder** can make a Developer ID certificate: Apple refuses an API key, both through the
App Store Connect API and for Xcode's cloud signing. So it is made once, by hand:

1. On the Mac: `macos/helper/build.sh --request-certificate`. It makes the key and the request
   `~/.config/whombat/helper/pending/whombat-helper.certSigningRequest` (running it again shows the same request).
2. The Account Holder, on developer.apple.com: Account → Certificates, IDs & Profiles → Certificates → **+** →
   **Developer ID Application**, profile type **G2 Sub-CA** → Continue → choose the request → Continue → Download.
3. On the Mac: `macos/helper/build.sh --import-certificate ~/Downloads/developerID_application.cer`. It checks the
   certificate is the team's and belongs to the waiting key, stores both in the keychain and deletes the key file.

The team's certificate (made 18 November 2026) runs until 18 December 2027. From 30 days before it runs out the build
stops and asks for a new one the same way. Helpers signed before then keep working (the signature carries a secure
timestamp), and one signed with the new certificate keeps its Accessibility permission, which macOS ties to the team
and the bundle id, not to one certificate. The old one is never revoked: that would stop every helper already
installed with it. The key's only copy is in the Mac's keychain; if that is lost, the same three steps make a new one.
