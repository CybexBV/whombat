# Groundwork notes

## Scope and assumptions

Mockups and evidence only. No app code, tokens, tests, decision docs or TODO changes. The top-level gallery and two scoring sheets are this task’s explicit shared-file exception. Work is confined to this branch and its assigned folder. The baseline app is not redesigned; the index places today’s screenshot beside an explicitly empty proposal slot. No decision is reopened.

“Usage” has no single current screen name. The sheet uses the shipped **Spend** page (`/settings?tab=advanced&part=spend`) for its everyday history view. The old `/settings?tab=usage` redirects to AI sign-in. Signed-in quota state is not captured and stays an additional state GAP; 06 should not silently rename either route.

All scores are this reviewer’s assessment of the screenshots and components, not measured participant performance. The proposed-design and verified-built-app columns are empty. Native screens have no numerical marks. The four platforms are never averaged to conceal missing coverage.

## Capture record

Reviewed code: `a105a3f6e` (the full revision is in SCORING.md). 48 before PNGs: 12 screens × two web widths × light/dark. Chromium, Playwright 1.63, device scale 1, en-GB, Europe/Amsterdam; desktop 1440×900, phone web 390×844. The existing tools/visual harness supplies openApp, its fixed 2026-09-23 11:22 clock, local theme, actual bundled fonts and motion reduction. Every image is the viewport, not an all-content screenshot. No real account, box or data was opened.

Fixture startup used `VITE_FIXTURES=1 VITE_FIXTURE_HOSTS=1 VITE_FIXTURE_DASHBOARDS=1 VITE_FIXTURE_FILES=1 VITE_FIXTURE_AUTOMATIONS=1`; local storage also enabled `whombat:fixture-looks=1`. Queries finished before capture. Lists were scrolled to the top. No fields, counts, copy or status values were patched into the cache. The assistant name stored with each capture is the shipped `agentWords(theAgentOf(bootstrap.principals)?.name).name` value; authored labels use `{assistant}`, never a fixed name.

T3 preview was tried first; its desktop snapshots repeatedly saved 1280×800 while reporting 1440×900. Those discarded captures are not the committed evidence. Switched to the repository’s Playwright Chromium capture after the repeated sizing failure. `capture.mjs` is the reproducible driver and `capture.json` contains the rendered text, viewport, helper name, minimum, failures and foreground/background pairs. PNGs are already compressed (about 3.9 MB for the required set).

To reproduce from the repository root, start the fixture app with the flags above and a free WEB_PORT, then `CAPTURE_URL=http://127.0.0.1:<port> node --import tsx docs/design-handoff/council-ui-2026-11/01-groundwork/capture.mjs`. The optional CAPTURE_PLATFORM=desktop or phone-web replaces only that platform in capture.json. Scores are an editorial assessment and do not automatically change with captures.

## Every pictured line has a source

The complete text of each fixture render is recorded in `capture.json`; it includes off-screen DOM text to make wording traceable, although the contrast scan and picture cover only the viewport. This table names the source of each line family, including navigation, times, fixed labels, numbers and fixture prose. No pictured product line needs new data. A proposed sample/check time on Overview, a consequence not supplied by an ask, or a new global evening-brief setting would be **needs new data**, and may appear only in a separately marked variant.

| Pictured line family | Data source | Renderer / formatter |
|---|---|---|
| Common shell: Burrow HQ, person, assistant, servers/connections, badges and Settings | apps/web/src/app/oneFixtures.ts; packages/fixtures bootstrap; home.overview/hosts fixtures | app/shell/AssistantSidebar.tsx; client agentName.ts, home/needsYouList.ts, home/statusLevel.ts |
| Chat first messages, subjects, replies, waiting/working and times | apps/web/src/app/chatChannelFixtures.ts; lookFixtures.ts; automationFixtures.ts | features/chats/ChatRoomScreen.tsx; messaging/MessageRow.tsx; client chat/rooms.ts, working.ts, chat/unread.ts |
| Thread question, 91% / 38 GB explanation, 16 GB request, restart reply and pending card | chatChannelFixtures.ts, PVE_THREAD / ZFS_APPROVAL | messaging/ThreadView.tsx; cards/ApprovalCard.tsx; core approvalView / approvalAnswer |
| Approval modal title, restart consequence, CALL · SERVERS, server_command, condition and answer labels | chatChannelFixtures.ts #902; approvalView resolves the stored call | features/approvals/ApprovalModal.tsx; core approval view/conditions |
| Inbox title, descriptions, source/time, research lines, answers, Settle, count | inboxFixtures.ts; oneFixtures.ts; lookFixtures.ts; hostsFixtures.ts | features/needsYou/NeedsYouScreen.tsx; client home/needsYouList.ts |
| Overview headline, tabs/counts, server names, CPU/memory/storage/temp, uptime/averages and waiting server | oneFixtures.ts home.overview; hostsFixtures.ts with dashboards enabled; packages/client/src/hosts/fixtures.ts | features/home/HomeScreen.tsx, ConnectionCards.tsx, connectionCards.ts; client home/greeting.ts and hosts/model.ts |
| Home Assistant head, address, Checked, integration/device counts, notices, SOON and research explanation | thingPageFixtures.ts; packages/fixtures/src service pages; lookFixtures.ts | features/things/page/ThingPageScreen.tsx, LookCard.tsx; dashboard/NoticeStrip.tsx; client home/thingPage.ts |
| pve-02 head, research line, metric verdicts/charts, busiest guests and backup facts | hostsFixtures.ts / client hosts fixtures; lookFixtures.ts | features/things/ServerPage.tsx and client hosts/dashboard.ts |
| Automations names, trigger descriptions, On/Off, waiting, last-run times and bars | apps/web/src/app/automationFixtures.ts | features/automations/AutomationsScreen.tsx; client automationView.ts; core plan/trigger formatters |
| Settings groups, Profile labels, fields and settling options | fixtureFetch.ts account/preferences; oneFixtures.ts; packages/client/src/settingsGroups.ts | features/settings/SettingsScreen.tsx and Profile form; client group/settle helpers |
| Vault entry labels, kinds, domains, stopped-password line, use times, explanatory copy | packages/fixtures/src/vault.ts; fixtureFetch.ts Vault entries; oneFixtures.ts | features/vault/VaultScreen.tsx and entry components |
| Files conversation names, counts, sizes and update times | apps/web/src/app/filesFixtures.ts, seeded files world | features/files/FilesScreen.tsx; shared file-size/time formatters |
| Usage/Spend Today, 7 days, 30 days, tokens/tasks/approximate dollars and estimate warning | packages/fixtures/src/spend.ts; client spend view from spend.overview | features/spend/SpendTab.tsx |
| Review-gallery and scoring prose | This review’s findings, scores.json and SCORING.md | Static review HTML; these are review labels, not fabricated product data |

Relative source paths above are from the repository root. The HTML and Markdown sheets link directly to each screen’s principal component and to its before image.

## Native gaps and routes

**N-IOS** and **N-ANDROID** are separate GAPs on every row below, for light **and** dark. Each native cell’s ten points and measured contrast remain GAP. The whole-app verdict is blocked.

Tried `apps/mobile/preview-runtime.cjs` first: it exports only `runtimeModuleSource`, which returns JavaScript module bytes containing a data URL. `metro-svg-transformer.cjs` uses it for sandboxed card previews; it does not mount React Native screens. A fixture-mode Expo web export was then attempted and stopped with `CommandError: ... required dependencies ... Install react-native-web@^0.21.2`. Installing a dependency or changing app code is outside this mockup-only task. A browser port of React Native would still not verify native iOS or Android.

Device discovery found local Android and Mac Studio iOS simulators. No device was opened: none had an attested fixture-only build from this checkout, and existing booted devices belonged to other work. This checkout has neither generated android/ios project nor a fixture binary. Native capture remains undone; it was not replaced by an HTML lookalike or by a managed-data build.

The route forward is a fixture-only native build using `EXPO_PUBLIC_WHOMBAT_MODE=fixtures` (apps/mobile README / DemoRoot), installed on an isolated emulator/simulator with device tools. Android: the supported `pnpm --filter @whombat/mobile android:apk --variant release` builds an x86_64 demo with that environment; iOS needs the same source/env built on the Mac. Then use the source-defined deep links below and switch light/dark inside the fixture app. DemoRoot starts its fixture clock at 14:05; a direct cross-platform comparison must align that fixture moment explicitly before scoring. The current source paths show valid routes; no claim that these native renders were tested.

| Screen | Native iOS | Native Android | Deep link after the fixture build |
|---|---|---|---|
| Chat list | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://chat` |
| A thread with its cards | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://threads/msg_chat-pve-memory` |
| An approval | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://approvals/902` |
| Inbox | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://inbox` |
| Overview | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://connections` |
| A connection page | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://things/connection%3Acon_home-assistant` |
| A server page | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://things/server%3Apve-02` |
| Automations | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://automations` |
| Settings | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://settings` |
| Vault | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://vault` |
| Files | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://files` |
| Usage | GAP N-IOS, both themes | GAP N-ANDROID, both themes | `whombat://spend` |

Native route source: `apps/mobile/src/navigation/routes.ts` (thread is `threads/:messageId`, not a query on the Chat tab). Different platform behaviour to preserve: iOS system tab bar/red system badge, SF chevron and previous title, native compact menu/form sheet, native confirmation alert; Android token badges, 48dp arrow and predictive back, app sheets and Material confirmation. Native learning rings are 10pt; web is 8px. Native approval card is a door to a full review screen; web can answer on the card.

## Measured contrast, light and dark

`contrast.js` runs over the rendered DOM. It converts sRGB to linear relative luminance and calculates (lighter + 0.05)/(darker + 0.05), compositing solid backgrounds and text opacity. It handles CSS color(srgb …), rgba and RGB. Sampled text must be visible in the viewport and not behind another element. The threshold for this round is 4.5:1 even for large type. Header/sidebar text is part of a screen; that is why the selected Settings label also affects Usage.

Limits: this is a small text-pair scan, not a WCAG conformance audit. Gradient/image/blend/filter backgrounds are skipped and their text is listed in capture.json; SVG text, input values/placeholders, focus indicators, icons, disabled-control exemptions and content below the viewport need separate checking. No screenshot-wide “pass” is claimed. Gradient research cards on connection/server pages are state-measurement GAPs in addition to the sampled ratios. Native measurement is entirely GAP.

| Failure in the actual render | Platforms / themes | Measured minimum | What would lift it (later implementation, not changed here) |
|---|---|---|---|
| Needs a look / Running warm pill | Desktop and phone web, light | 3.857:1 | Use the shipped warn-text foreground on the actual pill surface; remeasure it. |
| Overview 75 °C | Desktop, light (below first phone viewport) | 4.381:1 | Use an accessible warning text colour; preserve status meaning. |
| Selected Settings sublabel | Desktop Settings and Usage, light | 4.406:1 | Raise contrast against the actual selected surface without changing the token system. |
| Off / Not on yet automation row trigger text | Desktop and phone web, light / dark | 3.152:1 / 4.162:1 | Keep intentional-off rows quiet with hierarchy, not group opacity that fades their words. |

Every screen’s light/dark minima are in SCORING.md and scoring.html. The raw report keeps all unique foreground/background pairs and every failing text sample. Other sampled visible text passed; unmeasured areas remain unverified.

## Weak screens

Every captured screen/platform below is under 8; each is listed separately. There are no native scores to put below 8: their 24 screen/platform records stay GAP above. Marks are intentionally conservative where error/loading states and human task performance are not established.

| Screen | Platform | Today mean | Later step coverage and remaining weakness |
|---|---|---|---|
| Chat list | Desktop web | 7.1 | 02; 07 for phone comfort |
| Chat list | Phone-width web | 6.3 | 02; 07 for phone comfort |
| A thread with its cards | Desktop web | 7.3 | 03 for approval; 04 for other cards; 07 |
| A thread with its cards | Phone-width web | 6.6 | 03 for approval; 04 for other cards; 07 |
| An approval | Desktop web | 7.2 | 03; 07 |
| An approval | Phone-width web | 6.4 | 03; 07 |
| Inbox | Desktop web | 7.8 | 03 only for approval rows; 07; generic Inbox states are uncovered |
| Inbox | Phone-width web | 7.4 | 03 only for approval rows; 07; generic Inbox states are uncovered |
| Overview | Desktop web | 6.8 | 05 for freshness/errors; 07; metric hierarchy only partly covered |
| Overview | Phone-width web | 6.6 | 05 for freshness/errors; 07; metric hierarchy only partly covered |
| A connection page | Desktop web | 6.6 | 07 for phone comfort; connection contrast, heads-ups and state coverage are uncovered |
| A connection page | Phone-width web | 6.0 | 07 for phone comfort; connection contrast, heads-ups and state coverage are uncovered |
| A server page | Desktop web | 6.6 | 05; 07 |
| A server page | Phone-width web | 6.0 | 05; 07 |
| Automations | Desktop web | 7.1 | 05; 07; 04 for its plan card |
| Automations | Phone-width web | 6.4 | 05; 07; 04 for its plan card |
| Settings | Desktop web | 7.0 | 06 for findability; 07; selected-label contrast is uncovered |
| Settings | Phone-width web | 6.6 | 06 for findability; 07; selected-label contrast is uncovered |
| Vault | Desktop web | 7.3 | 06 for findability; 07; entry loading/reveal/error recovery is uncovered |
| Vault | Phone-width web | 6.7 | 06 for findability; 07; entry loading/reveal/error recovery is uncovered |
| Files | Desktop web | 6.8 | 06; 07 |
| Files | Phone-width web | 6.1 | 06; 07 |
| Usage | Desktop web | 6.7 | 07 for phone comfort; usage destination, quota context and state recovery are uncovered |
| Usage | Phone-width web | 6.2 | 07 for phone comfort; usage destination, quota context and state recovery are uncovered |

### Weaknesses no later step fully covers

- **Inbox, both web widths:** 03 addresses approval rows and 07 comfort, but general loading/empty/error recovery and folded-group comprehension have no owner. Capture an empty list, a failed read with Retry, a long assistant group and Undo focus/timeout; retain the shipped layout.

- **Connection page, both web widths:** 05 names server pages, Automations and Overview, not connections. Fix the status-pill contrast, audit the gradient research card and stale/partial-read explanation, and reconcile exposed SOON with the round’s folded-heads-up rule. A version changing UIR-70 needs “Decision for John — reopens UIR-70” beside a keeps-decision version.

- **Usage, both web widths:** 07 improves comfort, but no step owns the usage/spend/quota destination, estimate wording, live provider-usage state or recovery when those reads fail. Make its existing route and time window findable; identify the provider/source and whether the numbers are current. Don’t invent quota freshness.

- **Settings, desktop:** 06 findability will not by itself fix the selected Settings label’s measured contrast. Remeasure the actual selected background.

- **Vault entry content, both web widths:** 06 finds it and 07 sizes it; neither names failed reveal, locked/empty/loading, secret-copy feedback or focus after closing an entry. Keep secrets closed and give a clear recovery path.

- **Every native screen:** 07 is a comfort proposal, not native capture coverage. A source/HTML review cannot lift these GAPs. Collect iOS and Android fixture pictures and measured native contrast before any whole-app verdict.

## Accessibility and interaction record

For these review pages, screen-reader order is page navigation → theme button → heading/explanation → labelled selectors or score tables → evidence → footer. Viewer selectors are Screen, Platform, Picture theme. Images name the screen, platform and theme; full-size images are links. Tables use row/column headers; horizontal table regions are named and focusable. New evidence updates do not move focus. Theme toggle keeps focus on itself; selects retain focus. No overlays trap focus and no destructive action exists. Each control is at least 44 CSS px; native proposals must preserve 44pt iOS and 48dp Android.

The app observations come from source and screenshots, not complete keyboard/VoiceOver/TalkBack journeys. Preserve: drawer Close first, modal focus trap and return to its menu button; thread Back and Escape to the recorded origin; approval details close to its opener; a lasting yes opens the native/web confirmation and Cancel returns without deciding; Settle focuses the next row and Undo restores it; Android predictive back dismisses the open sheet before leaving. Screen-reader order should remain title/reason/source-time/action, with card content separate from each message’s combined author/time/body. Native message actions (Reply, Settle/Open again, More, Copy, links) stay reachable.

Expanded behaviour is captured only in the approval details modal. Technical details, More detail, additional notice rows, Vault entry details, automation detail/runs and the Heads-ups/Settled folds require their own before/after states in later steps. Keep aria-expanded and named panels; focus returns to the opener. Do not add a second standing-permission shortcut to a one-time answer.

Largest text is **not captured** here. Recheck 390px web at 200% zoom and both native platforms at their largest supported accessibility text; captions/labels wrap, actions stack, no sideways page scroll, no controls hidden under the keyboard or tab bar. Native source already stacks approval answers above scale 1.3 and sizes tabs by font scale; this is not evidence that every screen works. 07 owns that check. The static review pages also need a largest-text check before sharing widely.

No order moves under a finger: the review viewer changes only when a selector is used. Preserve the app’s stable sidebar order and native Overview order between explicit refreshes (UIR-06, AP-7454); don’t live-sort rows during review.

## References and decision boundaries

Read: ARCHITECTURE.md / DECISIONS.md / decision index, ui-refresh-*.md, quiet-notices.md, needs-you-list.md, handle-it.md, command-safety.md, phone-refresh-*.md and the design-handoff README. Earlier outcomes are not reopened. In particular, do not turn a timed-out/uncertain command into a safe Retry when its outcome is unknown. “Failed” remains local run/card detail, never a thread flag.

No .dc.html baseline changes in this groundwork. Later Chat/card/approval proposals should identify `design/Whombat Desktop.dc.html` and `design/Whombat Mobile.dc.html` where shared components change, plus the newer `chat-channel/index.html`, `home-redesign/proposed.html`, `connections/tabs.html`, `connections/server-cards.html`, `dashboards/index.html` and `settings-mobile/index.html` for their scopes. Files, Vault, Spend and Settings have built-app baselines in apps/web/visual; don’t claim an unrelated old .dc.html is their direct screen reference. Existing visual test images are not rewritten in a mockup round.

Status mapping: scales.html has 46 current word families and their source references; status-search.txt retains the requested rg evidence. NEITHER labels are contextual detail, not automatic defects. Flagged mismatches include automation Needs you outside Inbox, red Failed/Declined detail, and SOON heads-ups shown in the service strip. No replacement wording has been shipped or silently decided.

## Checks and delivery

The task explicitly requests no full test suite. **Passed:** `pnpm lint`, `pnpm notices --check`, `pnpm typecheck`; focused verification of links (six intentional parallel-workstream destinations pending), 48 capture dimensions/frozen dates/themes, 240 web marks, 24 native GAPs, 96 empty future score cells, and JavaScript syntax. Ten rendered review-page checks passed in light/dark, including desktop and phone viewer image/GAP switching, without JavaScript errors. Their sampled text minima are 4.641:1 light and 5.515:1 dark, both above 4.5:1. No app behaviour changes, so no Postgres or new test suite is needed. Existing services/data are untouched; temporary fixture/static servers are stopped after capture.

New gallery/scoring/scales pages had no before URL or prior screenshot. Their after pictures go in .whombat/shots; the 48 app before pictures are also copied there. Since no app appearance changes in this task, their after comparison uses the exact same fixture image; it should report no changed areas. Shot delivery tried the supplied HTTPS address first (DNS failed). The first HTTP fallback initially accepted six before/after pairs (12 pictures), all with no changed areas, then returned HTTP 500 “Whombat couldn’t take that picture.” Both HTTP fallbacks were tried for the remaining 84 app pictures and rejected them. All 48 before PNGs remain committed and copied locally; this external delivery failure does not erase capture coverage. All ten new review-page after pictures were also attempted on both HTTP fallbacks and rejected with the same HTTP 500. They remain in the local .whombat/shots folder. The per-view delivery summary is shot-delivery.json. No numbered change notes were needed for the accepted unchanged app comparisons.
