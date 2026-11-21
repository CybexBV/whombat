# Native fixture captures · 6 November 2026

This step records the shipped **iOS and Android apps**. It proposes no product fix or new decision. The gallery puts the groundwork’s missing native evidence beside actual native screenshots. There was no native before picture; today’s app pixels are also its unchanged before state. Only this folder and the two explicitly requested scoring sheets change. Web marks and future design/verification columns are preserved.

## Source, builds and isolation

Source: `641dcfd40353733591b77a23b33aa4f1d9db1d80`, after fetching origin and merging its default branch (already up to date). Phone/web client and shared-package code is identical to the groundwork revision `a105a3f6ed9246d984011241c12f9f212ce21a68`. Read the groundwork NOTES and SCORING first, then the handoff README and the current UI refresh, quiet-notices, needs-you-list, handle-it, command-safety and phone-refresh decisions. Existing health/stage language, Settle, folded heads-ups and native platform differences are recorded as shipped. No decision is reopened. No app code, tests, tokens, package manifest, lockfile or decision document is changed.

Both apps use `EXPO_PUBLIC_WHOMBAT_MODE=fixtures`: [DemoRoot](../../../../apps/mobile/src/demo/DemoRoot.tsx) constructs an in-memory fixture server and fake secure session. No real account, Whombat, device, service or data was used. No sign-in, secret reveal, approval answer or service control was submitted. The early iOS build that incorrectly selected the managed entry only showed an empty sign-in page; it was replaced before these captures and those test pictures are excluded.

- **Android:** new AVD `whombat-native-f028`, serial `emulator-5688`, Android 16 / API 36 Google APIs x86_64. 1170×2532 pixels at density 480, exported at ⅓ scale to **390×844**. New private disk under `agent-resource` lease `bf58acd1e74f4bf8a2ea109cf54f69e2`; no shared emulator was changed. Node 24.18.0, frozen pnpm install. Build: `EXPO_PUBLIC_WHOMBAT_MODE=fixtures pnpm --filter @whombat/mobile android:apk --variant release`; the default demo architecture is x86_64. Standalone Release APK, no Metro.
- **iOS:** new simulator `Whombat native f028`, UUID `DBDEE2E4-4C51-468B-86C7-927C6653CB63`, iPhone 14, iOS 27.0 on the Mac Studio. Native 1170×2532 pixels, exported at 1× to **390×844 points**. A new isolated `~/Code/Whombat-native-f028` was populated by `git archive` of the same source. Node 24.22.1, frozen install, Expo prebuild, CocoaPods and Xcode Release simulator build. No existing simulator or Mac checkout was used. iOS 27.1 only offered an incompatible device type, so the available iPhone 14 / 27.0 pair was selected.

The Xcode bundle step did not retain the fixture environment: its readable output contained `var DEMO = false`. The standalone app was corrected locally by explicitly bundling from the same unmodified source, verifying `var DEMO = true`, compiling that output with the build’s Hermes compiler, replacing only the generated `.app/main.jsbundle`, ad-hoc signing and installing on this simulator. This is a local binary operation, not a source patch. The relevant commands, from the isolated Mac checkout, are:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
cd apps/mobile
EXPO_PUBLIC_WHOMBAT_MODE=fixtures corepack pnpm exec expo prebuild --platform ios --no-install
cd ios
pod install
cd ..
EXPO_PUBLIC_WHOMBAT_MODE=fixtures xcodebuild -workspace ios/Whombat.xcworkspace -scheme Whombat -configuration Release -sdk iphonesimulator -destination 'id=DBDEE2E4-4C51-468B-86C7-927C6653CB63' -derivedDataPath ios/build/dd build
EXPO_PUBLIC_WHOMBAT_MODE=fixtures corepack pnpm exec expo export:embed --entry-file index.ts --platform ios --dev false --minify false --bundle-output /tmp/whombat-native-f028-fixture-readable.js --assets-dest ios/build/dd/Build/Products/Release-iphonesimulator/Whombat.app
# Assert the readable bundle selects DEMO=true before proceeding.
ios/Pods/hermes-engine/destroot/bin/hermesc -O -emit-binary -out ios/build/dd/Build/Products/Release-iphonesimulator/Whombat.app/main.jsbundle /tmp/whombat-native-f028-fixture-readable.js
codesign --force --sign - ios/build/dd/Build/Products/Release-iphonesimulator/Whombat.app
```

Build/install/code sync used SSH. All capture launches, deep links, settings, accessibility snapshots and screenshots used the device tool’s bound `agent-device` CLI. Device discovery initially failed twice; the user explicitly authorized SSH/simctl for this new simulator only. After its isolated boot, device tools discovered it and drove the captures. No fallback operated another simulator.

## Capture manifest and clock alignment

There are **84 compressed PNGs**: 48 standard native views (12 screens × 2 themes × 2 platforms), 16 largest-text native views (4 × 2 × 2), 12 missing-item route states (3 × 2 × 2), and 8 matching phone-web views. [iOS manifest](ios-capture.json), [Android manifest](android-capture.json), [iOS largest](ios-largest-capture.json), [Android largest](android-largest-capture.json), and [web clock manifest](web-moment.json) identify each image. Matching text files preserve the accessibility snapshots. PNG compression is lossless after the device CLI’s scale export. These are native screenshots, not a browser imitation of React Native.

[DemoRoot](../../../../apps/mobile/src/demo/DemoRoot.tsx) fixes the initial moment at **23 September 2026, 14:05 Europe/Amsterdam** (`12:05Z`), then [createClock](../../../../apps/mobile/src/lib/time.ts) advances it. There is no supported freeze parameter; app code could not change. Each native view restarts the app and captures just after navigation (elapsed seconds are in the manifests), keeping relative labels in the 14:05 minute. iOS receives its deep link after the initial fixture Chat is ready; sending it during launch can lose it. The OS status bar is normalized to 09:41; that is chrome, not the fixture clock.

Original web groundwork remains at **11:22**. To compare the waiting/working moment fairly, `capture-web-moment.mjs` uses the existing visual harness in fixture mode and Playwright Chromium, fixes the web clock at `2026-09-23T12:05:00Z`, and captures Chat, the memory thread, its approval and Overview in both themes at 390×844. These companions do not replace or rescore the earlier web baseline. Same story does not imply identical fixture IDs, totals or relative timestamps.

Reproduce native captures from the repository root with the command returned by `device_open` for your **own new** device:

```sh
NATIVE_CLI=/path/returned/by/device_open NATIVE_PLATFORM=ios python3 docs/design-handoff/council-ui-2026-11/08-native-capture/capture-native.py
# Repeat with android; NATIVE_LARGEST=1 captures the four text-size views.
# NATIVE_REQUESTED=1 captures the three supplied-ID failures.
```

The runner resumes an existing manifest; use a fresh output copy for a deliberate recapture. Standard system text category is `large`. Largest is iOS `accessibility-extra-extra-extra-large` (AX5), Android `accessibility-extra-large` (font scale **2.0**, Android Settings’ largest size). The source does not unlock the larger iOS sizes for every label.

## Routes and pictured data

All requested routes were tried. Three groundwork links use **web fixture IDs**. Their missing-item screens are retained in `*-requested-route-*.png`; the native counterpart supplies the scoring evidence. No made-up replacement data was added.

| Screen | Native deep link | Data and pictured line sources |
|---|---|---|
| Chat | `whombat://chat` | `fixtures/chatChannel.ts`, `chatRuntime.ts`: every author, message, time, reply count, waiting/working line and subject. `screens/ChatRoomScreen.tsx`, chat UI parts: headings, composer and actions. |
| Thread | supplied `threads/msg_chat-pve-memory`; native `whombat://threads/msg_chat-memory` | `CHAT_ROOTS.memory` and messages in `fixtures/chatChannel.ts`; `screens/ThreadScreen.tsx`: back, reply box and card door. Shared client/core formatters derive stage from flags and unread replies. |
| Approval | supplied `approvals/902`; native `whombat://approvals/33` | `ZFS_APPROVAL` and question in `fixtures/chatChannel.ts`; `screens/ApprovalScreen.tsx` and `data/approval.ts`: explanation, Technical details, lasting-yes row and one-time answer labels. |
| Inbox | `whombat://inbox` | `fixtures/fixture-server.ts` (NOTIFICATIONS), `fixtures/chatChannel.ts` and shared `packages/fixtures`: blackbox, restart, heat pump, reasons, times and counts. `screens/NeedsYouScreen.tsx` and needs-you UI: grouping and Settled. |
| Overview | `whombat://connections` | `fixtures/serverDashboards.ts`, `fixtures/parity.ts` and shared fixture hosts: names, versions, uptimes, health, meters and machine counts. `screens/HomeScreen.tsx` and server-card parts: tabs and summary wording. |
| Home Assistant | supplied `things/connection%3Acon_home-assistant`; native `whombat://things/connection%3Acon_ha` | `HOME_ASSISTANT` in `fixtures/thingPages.ts`: title, status, host, URL, controls, rooms and lower notices. `screens/thing/*`: Ask/Open, More detail, tab names, control state/units and expanded doors. |
| Server | `whombat://things/server%3Apve-02` | `fixtures/serverDashboards.ts`, `thingPages.ts` and shared host fixture: identity, version, figures, plots, warm notice, updates and counts. `screens/ServerScreen.tsx` and server/thing parts render summaries and folded heads-ups. |
| Automations | `whombat://automations` | `fixtures/automations.ts`, shared schedules and run fixtures: names, triggers, outcomes, next times and bars. `screens/AutomationsScreen.tsx`, client run-bar formatter: introductory words, On/Waiting and controls. |
| Settings | `whombat://settings` | `settings/groups.ts`, `screens/SettingsScreen.tsx`: shipped groups and descriptions; `fixtures/assistant.ts`: assistant identity; fixture principal and app build metadata: person/version. Theme is device state. |
| Vault | `whombat://vault` | Shared `packages/fixtures` Vault entries plus DemoRoot’s Deploy key: names, metadata, usage and statuses. `screens/VaultScreen.tsx`: explanation, closed rows and Add to Vault. No entry opened. |
| Files | `whombat://files` | `screens/FilesScreen.tsx`: heading/explanation only; `data/useFiles.ts` disables Files spaces in fixtures. **Content GAP**, no invented file list. |
| Spend | `whombat://spend` | Shared spend fixture and native fixture server: totals, windows, token/task/cost figures. `screens/SpendScreen.tsx` and spend parts: provider caveat and More about these numbers. |

Paths in the table are under `apps/mobile/src/` unless stated otherwise. The seed date, principal and shared entities come from `packages/fixtures/src`. System clock, battery, back glyphs and iOS tab badges are OS chrome. Icons/pictures are the shipped Lucide, avatar and fixture-picture renderers. No pictured line is newly written copy or “needs new data”.

The assistant name is resolved through `agentWords(assistantAgent().name).name` into [assistant.json](assistant.json), using native `fixtures/assistant.ts` and `packages/client/src/agentName.ts`. Gallery logic reads that value; no new product copy hard-codes the fixture assistant’s name.

## Accessibility and interaction evidence

The `*.txt` trees are observations of the loaded screen, not a VoiceOver/TalkBack certification. Source review establishes intended behavior; deep-link entry does not prove the participant can find a page. No independent participant timing, keyboard/switch-control journey, edge-back gesture or predictive-back test was performed.

| Screen family | Screen-reader names/order and focus return |
|---|---|
| Chat/thread | Title/header actions → scrollable combined author/time/body messages → subject and reply links → composer/model/Dictate/Send → tabs on Chat. Example reply link includes count and “Waiting for you, open the thread”. Thread exposes Review and answer separately. Stack Back returns to its prior screen; returning focus to the original row was not exercised. |
| Approval | Back → combined author/time → question → explanation → Technical details → lasting-yes control → Yes, now / Yes, tonight / No. Source places answers outside the content scroll area. Detail/confirmation focus containment and return are unverified; no answer was submitted. |
| Inbox | Heading → three problem/choice rows including reason/time → Settled → tabs. Expanded Settled and its focus return were not exercised. |
| Overview | Heading/status → Servers/Connections/Pinned → combined server identity/health/figures → machine door → tabs. Large text scrolls tabs. Source orders worst-first; no refresh was issued during capture. |
| Connection/server | Back/More → identity/status → host/address/actions → page tabs → named controls or figures → notices/heads-ups. iOS switches expose control names/state; Android also exposes duplicate unnamed switch nodes. Steppers have named decrease/increase actions in source. No control was changed. |
| Automations | Title/explanation → Tell field → automation rows (name, trigger, state and spoken run summary) → schedules → tabs. Detail/run and edit-sheet focus return remain untested. |
| Settings/Vault/Files/Spend | Group/entry/tile order follows the visible vertical order. Vault row names include state and last use without revealing secrets; Spend groups a tile’s window/tokens/tasks/cost. Files has no list to traverse. Deeper group navigation and reveal/confirmation focus were not tested. |

Touch requirements: iOS **44pt**; Android **48dp**. The shipped shared minimum is **44dp** (`ui/touchTarget.ts`, primitives and tabs). Android’s header Back is 48dp and large answer buttons are 52dp, but shared 44dp buttons/tabs/technical-detail rows do **not** establish universal 48dp compliance. This is recorded as an accessibility shortfall; pictures cannot verify expanded hit areas. No hit targets were changed.

Expanded behavior remains shipped: Technical details reveals execution detail; lasting approval asks for confirmation; More detail reveals connection diagnostics; heads-ups fold; Chat’s overflow hosts displaced actions; Spend’s More explains estimates. These expansion outcomes were source-reviewed, not pictured as new variants. Stable entity keys and the current list snapshot are preserved; no refresh/reorder was triggered while touching a row. Whether live data can reorder under a finger is an untested interaction GAP.

### Largest text observations

Both themes are captured for each requested screen on each platform. [Text.tsx](../../../../apps/mobile/src/theme/Text.tsx) defaults to `maxFontSizeMultiplier={1.6}`; some labels opt out or have their own limit.

- Chat: iOS messages become very large and the composer placeholder truncates; header actions move to More. Android wraps the composer onto two lines while Feedback remains visible. Much less history fits; scroll position remains latest-first.
- Thread: iOS’s large reply takes most of the viewport, but its pending card and Review and answer remain visible. Android shows more context. Root content above the viewport requires scrolling on both. The compact heading truncates; subject remains a separate control.
- Approval: all three answers stack vertically on both platforms, with content above; the question and explanation wrap. Controls and metadata do not all reach the requested AX5 size because of the cap.
- Overview: figures use two columns and fewer cards fit. iOS header/status grows more than Android; tabs extend horizontally. The rightmost tab needs horizontal scrolling. Sample freshness is still not established by visible figures.

## Contrast and scoring

[measure-contrast.mjs](measure-contrast.mjs) calculates WCAG relative luminance from current token RGBs and screenshot solid fills; [contrast-pairs.json](contrast-pairs.json) retains every selected pair and its source. Target is **≥4.5:1 light and dark**, including large text for this review. Per-screen sampled minima are in [scores.json](scores.json) and both scoring sheets. These are selected visible nominal pairs, not a minimum over every antialiased pixel or a complete contrast inspector audit. Image/gradient text, non-text icons/meters, OS status-bar text and off-screen content are excluded.

Two measured findings matter: iOS system badges use red `255,56,60` / `255,66,69`; even white numerals reach only **3.570:1 / 3.433:1**. They remain the shipped system badges. Home Assistant’s chart wash composites differently: iOS lit tile `251,239,228` / `64,44,30` gives muted text **5.047:1 / 4.484:1**; Android `251,239,229` / `63,44,29` gives **5.050:1 / 4.505:1**. iOS fails the requested dark threshold narrowly. Raw colours are sampled from PNGs, not inferred across platforms.

[Evidence](evidence.md) gives one line for each of the same ten points on every native row. Scores assess the present capture; empty/loading/error stays ≤6 where not exercised. Descriptive means over eleven scored screens are iOS **6.94**, Android **6.97**. Files is omitted as a GAP, never zero. The combining rule is unchanged: every screen/platform must clear the gates before a 9 or whole-app verdict. Future design and built-app verification columns stay empty.

## Remaining GAPs and references

- **N-FILES-IOS / N-FILES-ANDROID:** a populated Files view is impossible under the current native fixture gate. The heading scaffold is captured but all ten scores stay GAP. Whole-app verdict remains blocked by these two content gaps.
- Independent glance/find tasks, the evening-brief task state, most empty/loading/live-error/decided states, full screen-reader/keyboard/switch-control paths, expanded controls and live reorder behavior remain unverified. Missing supplied-ID screens demonstrate only those missing-item states.
- Largest text is captured, but the source’s 1.6× cap and Android’s shared 44dp targets remain limitations, not completed accessibility fixes.

No `.dc.html` baseline needs changing: these pictures document the existing implementation. Relevant references remain `Whombat Mobile.dc.html` and the existing native/phone variants in `docs/design-handoff/design/`. Any later change to those designs belongs to its owning step, not this evidence capture.

## Validation, delivery and teardown

Validation and resource/delivery results are recorded in [verification.json](verification.json) and [delivery.json](delivery.json). Local captures for sheet before/after and unchanged native before/after delivery are under ignored `.whombat/shots/`. The new gallery has no earlier picture to fabricate. No full test suite is run for this documentation-only task, as requested; repository lint, third-party notice check, typecheck and focused artifact/browser checks are used.

Completed validation: `pnpm lint` (30 pre-existing informational CSS diagnostics, no errors), `pnpm notices --check`, `pnpm typecheck`, Python/JavaScript syntax, PNG dimensions/counts/hashes, score arithmetic, ten evidence entries per platform/screen, identical web score tables, unchanged combining rule, local links and 96 empty future cells. Chromium verified gallery selections, loaded fonts and contained horizontal table scrolling at 1440×900 and 390×844, including 200% root text. Before/after sheet and new-gallery pictures are saved locally.

Picture delivery: the HTTPS hostname failed DNS resolution; each supplied HTTP IP returned **500**. No address accepted the initial before picture, so no after comparison numbers or numbered notes could be obtained. [delivery.json](delivery.json) records all three attempts; all images remain in this folder and the ignored local delivery folder.

Teardown: only the new iOS simulator was shut down/deleted, and only its isolated Mac checkout and task-prefixed temporary bundle files were removed. Android’s task lease is **closed**; `agent-resource check` reports `remaining: []`, `preserved_volumes: []`, `errors: []`. Its AVD pointer is absent. The task’s Vite fixture server and browser tab are closed. No VM/container/emulator/simulator is retained. The ignored local APK/native build outputs and `.whombat` logs/pictures remain in this worktree for review. No existing dev service needs rebuilding for a documentation-only change.
