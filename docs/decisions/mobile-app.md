# Workstream: mobile-app (`apps/mobile`)

TODO 15.1–15.5 (UI + data). Native, Android first, iOS kept buildable (DECISIONS D-08; 15.1 is settled by
D-08). ARCHITECTURE.md ("Mobile"), `client.md`, `avatars.md` and `fixtures.md` still apply; this file
records what they left open. Build, run and screenshot instructions: `apps/mobile/README.md`.

## Setup

| # | Decision | Reason |
|---|---|---|
| MA-01 | Same line as DigitalBrain: Expo SDK ~57, RN 0.86.3, React 19.2.3, Hermes, new architecture, `app.config.cjs` + `eas.json`, local Gradle builds via `scripts/build-android.mjs` (prebuild → `android/`, gitignored). | The maintainer's proven setup; no EAS needed to build or test. |
| MA-02 | **React Navigation 7** (native stack + bottom tabs) directly, not expo-router. The stack holds the tabs and pushes Approval / Dm / Conversation / Agent full screen (no tab bar, as in the mock); deep links through `linking` (`whombat://approvals/12`, `dm/pippa`, `agents/dusty`, `c/billing-v2`, `search?q=`). ARCHITECTURE's package table is updated. | DigitalBrain does not use expo-router either; every header and the tab bar are custom per the mock, typed param lists are explicit, and there is no generated `app/` route tree or typed-routes step in the monorepo `tsc` run. expo-router is React Navigation underneath, so switching later is cheap. |
| MA-03 | Metro watches the repo, resolves workspace packages through their `exports` (TypeScript source) and resolves **React, React Native, react-native-svg, safe-area, TanStack Query (+ core) and Zod from the app** whoever imports them. | Workspace packages carry React 19.3 / their own react-query as devDependencies for web tests; without the redirect `@whombat/client/react` would load a second React. The bundle is checked to contain one React. |
| MA-04 | Lucide icons are imported per module (`lucide-react-native/icons/<name>` via `src/ui/icons.ts`). | Metro does not tree-shake; the barrel bundles ~1,800 icons (3,166 → 1,439 modules). |
| MA-05 | `crypto.getRandomValues` from `expo-crypto` is installed on `globalThis` before anything else (`index.ts` → `src/polyfills.ts`). Hermes' `Intl` handles IANA zones and `formatToParts`; `resolveTimeZone` still probes zones and falls back (preference → burrow → device → UTC). | `@noble/hashes` (ids, fixture signing) reads `globalThis.crypto`; core's time formatting needs explicit zones. |
| MA-06 | Fonts: `@expo-google-fonts` static Bricolage Grotesque 400–700 and DM Mono 400/500 under `nativeFontFamilies`' names; `Text` applies CSS line boxes (`normal` = 1.2 / 1.302), em tracking and `includeFontPadding: false`. | The static Bricolage files are the opsz 14 instance; Chrome's automatic optical sizing differs by 0.2 % in width at 15.5 px (2.3 % at 34 px). RN has no `font-variation-settings` on Android, so static files it is. |

## Data and session

| # | Decision | Reason |
|---|---|---|
| MA-07 | Sign-in is email → 6-digit code (`auth.requestMagicLink` / `auth.verify` with `client: 'mobile'`); the bearer token, server address, burrow, email, mode and theme live in `expo-secure-store`. A 401 anywhere signs out. The burrow is the saved one while still a member (`me.get`), else the first membership. Dev default server `http://10.0.2.2:4400` (`EXPO_PUBLIC_WHOMBAT_SERVER`), editable on the sign-in screen. *Superseded for the default address by `mobile-server.md` MS-01: an unconfigured build starts from `https://app.whombat.com`; dev builds set `EXPO_PUBLIC_WHOMBAT_SERVER`.* | The magic link opens the web app; the code works on any device. |
| MA-08 | One `createClient({baseUrl, getToken})` per session and one `createRealtime({url: ws(s)://…/ws?burrow=<slug>, token})` per burrow; `bindAppLifecycle` reconnects at once on AppState `active` and NetInfo online, and feeds TanStack's `focusManager` / `onlineManager`. The QueryClient is per session (the signed-in root remounts by session key). | RN's equivalent of `@whombat/client/web`'s browser lifecycle; no cache leaks across accounts. |
| MA-09 | **Fixture mode** = `createFixtureFetch()` wrapped by `src/fixtures/fixture-server.ts`: it adds `notifications.inbox` (Mara's inbox from `NOTIFICATIONS`, mock order), serves approval #12 at the **mobile mock's moment** (checks green on 7be20f, Hazel approved 11:38; Approve → APPROVED · DEPLOYING with Undo, Decline → DECLINED, Undo → pending) and swaps it into every response that embeds it, and stands in for realtime (an agent woken by a message sends a `typing` "thinking" event, its reply arrives as `message.created` 1.6 s later and is hidden from history until then). The fixture world is loaded with `import()` only in this mode. `@whombat/fixtures` is not changed. | Screenshots and demos without a server that match the mobile mock, through the same client, cache reducers and screens as the server path. FX-12 leaves `notifications.inbox` to consumers. |
| MA-10 | Fixture sends are **re-stamped** after the conversation's latest message (the fixture world stamps new messages with its 11:22 seed time, older than the DM's 14:0x history). | The cache orders messages by time; a new message would otherwise land at the top. |
| MA-11 | The app clock is real against a server; in fixture mode it starts at the seed moment and runs forward. `useNow()` reads the clock at render (rounded **up** to the second) and re-renders every 30 s. | "you · just now" right after deciding; a stale render-time clock showed the decision in the future ("11:23"). |
| MA-12 | Against a server the app shows the **live state** (B-04): the seed is the desktop's 11:22 (38 of 41 · fixing, changes requested). `pnpm demo:play` reaches the mock's moment; Approve then executes at once (demo executor) → APPROVED · DEPLOYING → DEPLOYED, and Undo is disabled while executing / after executing, as core's `undoBlock` says. | Core owns the approval state machine; the mock's Undo after "deploying" is the fixture moment (execution not started). |
| MA-13 | Theme: System / Light / Dark in the settings sheet (opened from the avatar next to "Inbox"). System follows the OS until a choice is made; the choice is kept on the device and, against a server, is the account's `preferences.theme` (read from the bootstrap, saved with `me.updatePreferences`). | README: "persist per user; respect prefers-color-scheme on first load". |

## UI

| # | Decision | Reason |
|---|---|---|
| MA-14 | Sizes are the mock's px as dp. The reference emulator is 368 × 822 dp at 3× (the mock's 390 × 844 phone minus its 11 px bezel), so screenshots compare 1:1 after a 3× downscale. The status bar is the device's; bottom paddings swap the mock's iPhone home inset (34) for the device's (`bottomPadding`: tab bar 28, composer 34, footers 36 → device inset + the rest, never below the bar's top padding; the composer drops it while the keyboard is up). | The mock is an iPhone frame; Android has its own insets. |
| MA-15 | Avatars: `@whombat/avatars`' tree rendered with react-native-svg. The shadow filter primitives (feOffset, feGaussianBlur, feComposite, feFlood, feMerge) are **not mapped**, so every avatar renders the `effects: false` tree (AV-05); `filter` + `feColorMatrix` stay for the silhouette. Pixel snapping uses `size × PixelRatio`. | react-native-svg 15.15 draws those filter chains wrongly on Android: filtered shapes are clipped or dropped (at 44 dp the sweater, muzzle and nose vanished; at 112 dp the nose was cut). Without effects the avatars match the reference closely. |
| MA-16 | Tab bar: Lucide `Inbox`, `Hash`, `Bot`, `Search` at 22 dp in the mock's slots; active = ink with a 2.25 stroke, inactive = mut at 1.75 (the mock's filled placeholder cannot be a line icon). The DM send button is the mock's 32 dp `btn` circle with an `ArrowUp` in `btnfg` (the mock's circle is empty). | README "Icons": one line-icon set in the same slots; a send button needs a glyph. |
| MA-17 | The inbox status line after deciding uses `approvalView`'s tone (DECLINED in `bad`); the mock paints every status line `ok`. | Deliberate deviation: everywhere else (mock approval screen, desktop) declined is `bad`. |
| MA-18 | Chat: Enter sends (`submitBehavior="submit"`; the draft is read from a ref so a double Enter cannot send twice); the list follows new messages while the reader is at the end and stays put while older pages load; "{name} is thinking" is a bubble with three dots under the last message. | "Enter sends" (README interactions); hardware keyboards fired submit twice before a re-render. |
| MA-19 | Unmocked screens follow the inbox language (B-05): **Channels** = CHANNELS / BRANCH ROOMS / DIRECT grouped lists (44 dp `#` / branch tiles, member count, unread badge = btn pill, PR status dot); **Conversation** = the DM's header and bubbles plus author lines (24 dp avatar, name, time) and compact card summaries (approval cards open the approval screen); **Agents** = roster rows (44 dp wombat, role · status, dot, doing, keys summary); **Agent** = the approval screen's hero + RIGHT NOW / KEYS (✓ ? ×) / CHANNELS / RECENT + "Message {name}"; **Search** = pill field, type chips with counts, the agent's answer, result rows (author · TYPE · where · snippet · "receipt n"); **Sign in** and **Settings** use the same primitives. | Quiet, same visual language; copy from `@whombat/core` helpers where it exists. |
| MA-20 | `modules/whombat-live` is the live-activity seam: pure `runActivity` / `approvalActivity` / `activityFromPush` content (the cards' copy) and a `WhombatLive` bridge that is a no-op until a native module named `WhombatLive` exists (`requireOptionalNativeModule`). | The notifications phase adds `expo-module.config.json`, `android/`, `ios/` without touching screens. Done: `mobile-live.md` (the content moved to `@whombat/core`'s `LiveActivityDisplay`). |

## Known differences from the mock

- Server inbox order is newest first, so Pippa (14:04) comes before Priya (10:40) under MENTIONS; the mock
  lists Priya first (its 14:04 is "later today" relative to 11:22). The fixture inbox keeps the mock order.
- The DM uses the fixture world's DM copy, which is the desktop's longer wording (FX-02).
- Android status bar and gesture inset instead of the iPhone's 9:41 bar and home indicator (MA-14).

## Contract changes

None. `@whombat/core`, `@whombat/client`, `@whombat/fixtures`, the server and the web app are unchanged.

## Tests

Vitest in Node for everything that does not import React Native (`src/**/*.test.ts`,
`modules/**/*.test.ts`), part of the root `pnpm check` with the app's `tsc`: avatar tree mapping and the
native tag set, fixture server (inbox, approval moment, approve / decline / undo, live agent replies,
re-stamping), view models (inbox, approval, chat, channels, routes, config, theme, text metrics, insets),
session + sign-in against a fake server, lifecycle reconnects, live-activity content. UI is verified on
the emulator against `pnpm ref:shot --file mobile` in both themes (README).
