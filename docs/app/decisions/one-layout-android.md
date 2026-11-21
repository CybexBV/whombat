# One layout on the phone, from the first frame (AP-2640…AP-2649)

John, 2026-10-19: “When I start Whombat on the Android device, it shows a different screen first and then it loads the
new screen, inclusive the menu bar … this needs to be very smooth and fast.” The cause: the app draws its first screen
from what it kept (AP-920, AP-921) before the session with the Whombat is open, but the bar was chosen from the
Whombat's `welcome.runtime`, which only comes with the open session. Until then the phone assumed an older Whombat and
showed the crew bar (Inbox · Channels · Agents · Search) on the Inbox; a second later Chat · Connections · Watch ·
Settings. The saved place was restored in that first second too, under the crew's rules, so a thread, a server or a
Settings page open at the last close was dropped. Discussed options: (1) remember the runtime and hold the logo, (2) one
layout only; John chose both: “Implement this fully.”

## AP-2640 One layout

**Superseded in part by needs-you-list.md NYL-05 and automations-tab.md AP-6310**: the bar is Chat · Needs you ·
Connections · Automations · Settings.

The phone has one bar: Chat · Connections · Watch · Settings, and opens on Chat. The crew's set (Inbox, Channels,
Agents, Search) and the task-chat set (Connections · Chats · Watch · Settings) are gone with their tab screens (Inbox,
Channels, Agents, Search, Chats) and the screens only they opened (Browse channels, New message). `ShellMode`, `TabSet`,
`useShellMode`, `useTabSet`, `useChatShell` and `EXPO_PUBLIC_WHOMBAT_SHELL` are gone: nothing on the phone depends on
which shell a Whombat runs any more. Every Whombat runtime advertises `shell.assistant` and `chat.channel` unless it is
started with `WHOMBAT_SHELL=crew`, which no appliance does (Whombat `runtime-features.ts`).

## AP-2641 A Whombat without Chat asks for its update

A managed Whombat whose open session lacks `chat.channel` (an appliance from before Whombat chat-channel.md, one from
before contracts 0.22 that says nothing, or one run as the crew) gets the screen an appliance too old for the app
already had instead of the app: “Your Whombat needs an update”, that Whombats update themselves, and “Back to your
Whombats” — no new words. John accepted this when choosing option 2: the phone opens only Whombats with the one-Whombat
update. The legacy server and the demo world have every feature.

## AP-2642 What the Whombat can do is remembered

The last `welcome.runtime` (version, API level, features) is kept per Whombat in the device box (`runtime`, beside the
navigation state and the query cache), read ahead at start with them (`readAhead`) and used until the session opens; an
open session's own answer replaces it and is kept when it differs. So screens that check a feature (about 50:
Connections' “Add a connection”, the Settings rows, skills, servers) show what they will show from the first frame, not
a second later. Nothing kept (this phone's first time with this Whombat): as before, the features every Whombat had
before contracts 0.22, until it answers.

## AP-2643 The logo stays until the first screen is drawn

Android's launch screen (the logo on the theme's `bg`) stays up while the app gets ready instead of giving way to
blank frames, a spinner and placeholder rows: the fonts, the kept sign-in, the Whombat being opened, its burrow, the
saved place and the navigator asking whether a link opened the app (its `fallback`). Each of those placeholders is a
`StartHold`; the logo goes two frames after one is committed with none of them (`lib/launchScreen.ts`), and at the
latest after 3 s, when the waiting is shown as it was. Sign-in, the Whombat list and errors are screens like any other:
the logo gives way to them. The first commit counts from inside the providers (`useLaunchSettle` in `ManagedRoot` and
`Root`): the safe area renders nothing until it is measured, so a check at the app's root let the logo go at 27 ms,
before any placeholder had mounted. Measured on the emulator (demo world, cold start): logo, then Chat with its
messages and the bar in one fade; before, logo, a blank frame, a spinner, Chat's placeholder rows, then Chat.

## AP-2644 Chat is loaded up front

The navigator imports the Chat room's screen eagerly (the one it opens on), not the Inbox; every other screen is still
required the first time it shows (AP-932).

## AP-2645 Old addresses and saved places

**Superseded in part by docs/decisions/phone-shell-final.md PSH-05**: a search link opens the phone's Search.

`inbox`, `agents`, `dashboard`, `home` and `things` open Connections; `chats` and `channels` open Chat. A search link has
no phone screen any more: it opens on the web like an external link. A saved place on a removed tab opens Chat with the
screens above it (CHT-22: no tab is restored); a saved Browse channels is not restored. Pushes land as before: an alert
on Watch, anything else on Connections. Leaving or deleting a conversation goes back to Chat, a removed member's
“leave” back to Connections.

## AP-2646 Developer builds keep the demo world and the server sign-in

Builds without `EXPO_PUBLIC_WHOMBAT_TRANSPORT=session` (the demo world, a self-hosted server over HTTP) are never
published; the demo world is how screens are checked on the emulator. They stay, with the same one layout (their
runtime has every feature). Removing them would not make the installed app start faster: it never loads them.

### whombat-app 0.96.0

AP-2640…AP-2646. Phone only: the web and the shared packages are unchanged, so no Whombat vendor pin or candidate (as
AP-897); the APK is published to DEV. Checks: `pnpm check` (4364 tests); the demo world's release APK on the emulator —
cold starts recorded at 30 fps in light and dark (logo, then Chat with its messages and the bar in one fade), the old
tabs' addresses (`inbox`, `agents` → Connections; `channels`, `chats` → Chat), and the screens the sweep touched
(the assistant's page, Vault, Spend, Settings → AI and Profile, Skills, Everything I did, Connections, Chat). Not seen on
a device: a managed cold start against a real Whombat (the kept runtime and the update screen are unit-tested).
