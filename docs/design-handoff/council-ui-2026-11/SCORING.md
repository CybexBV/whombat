# Whombat · scoring sheet

A screen’s score is the mean of its ten points, separately on each platform. The app’s score is the mean of its screens. A 9 for the app requires every screen ≥ 8 on every platform and no point below 7. Any GAP (a screen/platform not captured) blocks a whole-app verdict and must be listed. Never fill a GAP with a zero or a score borrowed from another platform.

**Whole-app verdict: BLOCKED — 2 native Files-content GAPs; all 48 standard native light/dark views captured.**

Today’s web baseline remains a105a3f6ed9246d984011241c12f9f212ce21a68. Native was captured from 641dcfd40353733591b77a23b33aa4f1d9db1d80 on 6 November 2026; phone/web client code is identical between those revisions. This is a fixture review, not a production-device audit. Web groundwork clock: 23 September 2026, 11:22 Europe/Amsterdam; native restarts at 14:05, with matching 14:05 web companions for Chat, thread, approval and Overview. Desktop 1440×900; phone web and native pictures 390×844.

## How to mark

Marks are out of 10: 1–3 obstructs the task; 4–5 substantial friction; 6 usable with clear gaps; 7 good but needs work; 8 strong evidence for this screen; 9 excellent across the task and states; 10 no material weakness in this review. The empty/loading/error mark is capped at 6 where those states were not exercised. Desktop phone-density means whether the same content adapts coherently to 390px, not how much fits on a large monitor. Accessibility marks include source/DOM review, not a claim of assistive-technology certification.

Point order: **H** Hierarchy, **C** Web/phone consistency, **F** Findability, **G** Cards at a glance, **S** Empty/loading/error states, **D** Phone density, **T** Typography, **K** Colour and measured contrast, **A** Accessibility, **Q** Calm and trust. Each Today cell contains its mean, then all ten marks in that order. No score has been awarded to a future design or future built-app verification.

## Today, proposed design, verified in the built app

| Screen | Desktop web · Today | Proposed design | Verified in the built app | Phone-width web · Today | Proposed design | Verified in the built app | Native iOS · Today | Proposed design | Verified in the built app | Native Android · Today | Proposed design | Verified in the built app |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Chat list | 7.1 · 7/7/7/6/6/7/8/8/7/8 | | | 6.3 · 6/6/6/5/6/6/7/8/6/7 | | | 6.5 · 7/7/7/6/6/6/7/5/7/7 | | | 6.7 · 7/7/7/6/6/6/7/8/6/7 | | |
| A thread with its cards | 7.3 · 8/7/7/7/6/7/8/8/7/8 | | | 6.6 · 7/6/7/6/6/6/7/8/6/7 | | | 7.4 · 8/7/7/8/6/7/8/8/7/8 | | | 7.3 · 8/7/7/8/6/7/8/8/6/8 | | |
| An approval | 7.2 · 7/6/8/7/6/7/8/8/7/8 | | | 6.4 · 6/6/7/6/6/5/7/8/6/7 | | | 7.5 · 8/7/8/8/6/7/8/8/7/8 | | | 7.4 · 8/7/8/8/6/7/8/8/6/8 | | |
| Inbox | 7.8 · 8/8/8/8/6/8/8/8/8/8 | | | 7.4 · 8/7/8/7/6/7/8/8/7/8 | | | 7.3 · 8/7/8/8/6/8/8/5/7/8 | | | 7.5 · 8/7/8/8/6/8/8/8/6/8 | | |
| Overview | 6.8 · 7/7/8/7/5/7/7/6/7/7 | | | 6.6 · 7/7/7/6/5/6/7/8/6/7 | | | 6.5 · 7/7/8/7/5/6/7/5/7/6 | | | 6.7 · 7/7/8/7/5/6/7/8/6/6 | | |
| A connection page | 6.6 · 7/7/7/7/5/7/7/5/7/7 | | | 6.0 · 6/7/6/6/5/5/7/5/6/7 | | | 6.6 · 7/7/7/7/5/6/7/6/7/7 | | | 6.6 · 7/7/7/7/5/6/7/7/6/7 | | |
| A server page | 6.6 · 7/7/7/7/5/7/7/5/7/7 | | | 6.0 · 6/7/6/6/5/5/7/5/6/7 | | | 6.8 · 7/7/7/7/5/7/7/7/7/7 | | | 6.7 · 7/7/7/7/5/7/7/7/6/7 | | |
| Automations | 7.1 · 8/8/7/7/6/7/8/5/7/8 | | | 6.4 · 7/7/7/6/6/6/7/5/6/7 | | | 6.8 · 8/7/7/7/6/7/7/5/7/7 | | | 6.9 · 8/7/7/7/6/7/7/7/6/7 | | |
| Settings | 7.0 · 8/7/6/7/6/7/8/6/7/8 | | | 6.6 · 7/7/6/6/6/6/7/8/6/7 | | | 7.1 · 8/7/7/7/6/8/8/5/7/8 | | | 7.3 · 8/7/7/7/6/8/8/8/6/8 | | |
| Vault | 7.3 · 8/7/7/7/6/7/8/8/7/8 | | | 6.7 · 7/7/6/6/6/6/7/8/6/8 | | | 7.1 · 8/7/6/7/6/7/7/8/7/8 | | | 7.0 · 8/7/6/7/6/7/7/8/6/8 | | |
| Files | 6.8 · 7/7/5/6/6/7/8/8/7/7 | | | 6.1 · 6/6/5/5/6/5/7/8/6/7 | | | GAP N-FILES-IOS (all ten) | | | GAP N-FILES-ANDROID (all ten) | | |
| Usage | 6.7 · 7/7/5/7/6/7/8/6/7/7 | | | 6.2 · 6/6/5/6/6/5/7/8/6/7 | | | 6.7 · 7/7/5/7/6/6/7/8/7/7 | | | 6.6 · 7/7/5/7/6/6/7/8/6/7 | | |

Captured-platform means: desktop **7.02**, phone web **6.44**. These are descriptive baseline means, not a whole-app score. Native descriptive means over eleven scored screens: iOS **6.94**, Android **6.97**; Files is excluded as a GAP. [Native marks and one evidence line per point](08-native-capture/evidence.md). Do not round a screen up across the 8-point gate.

## Evidence and measured text contrast

Minimum sampled text contrast, **light / dark**. Target ≥4.5:1 in both themes, including large text for this round. Shell text is included; only text visible in that screenshot is sampled. Source details, excluded gradient content and complete RGB pairs are in [capture.json](01-groundwork/capture.json). This is not a complete accessibility audit. Native sampled pairs and platform-specific pixel evidence are recorded below.

| Screen | Desktop light / dark | Phone web light / dark | One line of evidence |
|---|---|---|---|
| Chat list | 4.888:1 / 6.013:1 | 4.888:1 / 6.013:1 | [Before](01-groundwork/png/desktop-chat-list-light.png), [ChatRoomScreen.tsx](../../../apps/web/src/features/chats/ChatRoomScreen.tsx): Waiting and replies are separate rows; several threads read alike and the first pending question pushes later work below the fold. |
| A thread with its cards | 4.888:1 / 5.515:1 | 5.428:1 / 5.515:1 | [Before](01-groundwork/png/desktop-thread-light.png), [ThreadView.tsx](../../../apps/web/src/features/messaging/ThreadView.tsx): The ZFS question, replies and pending card stay together; the phone’s reply box competes with the card near the bottom. |
| An approval | 4.583:1 / 6.013:1 | 4.583:1 / 6.013:1 | [Before](01-groundwork/png/desktop-approval-light.png), [ApprovalModal.tsx](../../../apps/web/src/features/approvals/ApprovalModal.tsx): The details modal exposes CALL · SERVERS and server_command; the thread card uses Yes, now / Yes, tonight / No, while the modal offers Yes, do it / No. |
| Inbox | 4.888:1 / 5.515:1 | 5.618:1 / 5.515:1 | [Before](01-groundwork/png/desktop-inbox-light.png), [NeedsYouScreen.tsx](../../../apps/web/src/features/needsYou/NeedsYouScreen.tsx): Needs you leads with the failed disk array and one way forward; phone rows wrap naturally and Settled remains a flush bar. |
| Overview | 4.381:1 / 5.180:1 | 4.888:1 / 5.180:1 | [Before](01-groundwork/png/desktop-overview-light.png), [ConnectionCards.tsx](../../../apps/web/src/features/home/ConnectionCards.tsx): Worst-first server cards make blackbox obvious; Used today / uptime and 24 h average do not establish when the figures were sampled. The 75 °C value fails light contrast. |
| A connection page | 3.857:1 / 5.515:1 | 3.857:1 / 6.013:1 | [Before](01-groundwork/png/desktop-connection-light.png), [ThingPageScreen.tsx](../../../apps/web/src/features/things/page/ThingPageScreen.tsx): Home Assistant gives Checked 2 min ago and folds More detail; the light Needs a look pill is 3.857:1 and SOON heads-ups remain visible. |
| A server page | 3.857:1 / 5.515:1 | 3.857:1 / 5.515:1 | [Before](01-groundwork/png/desktop-server-light.png), [ServerPage.tsx](../../../apps/web/src/features/things/ServerPage.tsx): pve-02 says Running warm above neutral summary figures and a live research line; its light pill is 3.857:1 and the visible figures lack a sample time. |
| Automations | 3.152:1 / 4.162:1 | 3.152:1 / 4.162:1 | [Before](01-groundwork/png/desktop-automations-light.png), [AutomationsScreen.tsx](../../../apps/web/src/features/automations/AutomationsScreen.tsx): The list gives a trigger, state and last run; off/not-on rows fade their readable text to 3.152:1 in light and 4.162:1 in dark, and long phone names truncate. |
| Settings | 4.406:1 / 4.904:1 | 4.854:1 / 4.904:1 | [Before](01-groundwork/png/desktop-settings-light.png), [SettingsScreen.tsx](../../../apps/web/src/features/settings/SettingsScreen.tsx): Five shipped groups are present; the selected sidebar Settings sublabel is 4.406:1 in light, and the evening brief is not a setting in these groups. |
| Vault | 4.888:1 / 5.515:1 | 4.888:1 / 5.515:1 | [Before](01-groundwork/png/desktop-vault-light.png), [VaultScreen.tsx](../../../apps/web/src/features/vault/VaultScreen.tsx): Entries keep secrets closed and Printer admin clearly says its password stopped working; the phone reaches Vault through a different navigation path. |
| Files | 4.888:1 / 6.013:1 | 4.888:1 / 6.013:1 | [Before](01-groundwork/png/desktop-files-light.png), [FilesScreen.tsx](../../../apps/web/src/features/files/FilesScreen.tsx): The page lists conversation spaces with counts and sizes, but is reached from Chat’s Files control rather than the main web sidebar. |
| Usage | 4.406:1 / 5.235:1 | 4.888:1 / 5.515:1 | [Before](01-groundwork/png/desktop-usage-light.png), [UsageScreen.tsx](../../../apps/web/src/features/spend/UsageScreen.tsx): The shipped Spend page under Advanced gives Today, 7 days and 30 days; the legacy Usage address instead opens AI sign-in, so the name does not identify one destination. |

## Native evidence and measured text contrast

Selected visible text pairs, light / dark, from tokens and solid screenshot backgrounds. Target ≥4.5:1; not a full-screen scan or accessibility certification. iOS tab-badge white text has a maximum contrast of 3.570:1 / 3.433:1 on the sampled system red. Home Assistant’s dark lit control rounds differently: iOS 4.484:1 fails; Android 4.505:1 passes narrowly. [RGB pairs and method](08-native-capture/contrast-pairs.json). [All ten evidence lines per screen/platform](08-native-capture/evidence.md).

| Screen | Native iOS light / dark | Native Android light / dark | Evidence |
|---|---|---|---|
| Chat list | 3.570:1 / 3.433:1 | 4.888:1 / 5.515:1 | [Pictures](08-native-capture/index.html?screen=chat-list) · Waiting replies stay with each question; the latest-first viewport starts partway through older content. |
| A thread with its cards | 5.281:1 / 5.515:1 | 5.281:1 / 5.515:1 | [Pictures](08-native-capture/index.html?screen=thread) · The memory question, replies and pending approval remain together; Review and answer opens the decision screen. |
| An approval | 5.281:1 / 6.013:1 | 5.428:1 / 6.013:1 | [Pictures](08-native-capture/index.html?screen=approval) · One-time answers stay in the footer; the lasting yes sits apart and asks for confirmation. Native uses approval 33. |
| Inbox | 3.570:1 / 3.433:1 | 4.888:1 / 5.515:1 | [Pictures](08-native-capture/index.html?screen=inbox) · blackbox comes first, followed by the restart and heat-pump choice; Settled stays at the bottom. |
| Overview | 3.570:1 / 3.433:1 | 4.641:1 / 4.904:1 | [Pictures](08-native-capture/index.html?screen=overview) · Worst-first server cards identify blackbox; the figures still do not establish their sample time. |
| A connection page | 5.047:1 / 4.484:1 | 5.050:1 / 4.505:1 | [Pictures](08-native-capture/index.html?screen=connection) · Home Assistant shows status, host, address and folded detail above controls; the native connection is con_ha. |
| A server page | 5.281:1 / 5.515:1 | 5.428:1 / 5.515:1 | [Pictures](08-native-capture/index.html?screen=server) · pve-02 groups plain-language figures, a warm-CPU notice and folded heads-ups; sample freshness remains limited. |
| Automations | 3.570:1 / 3.433:1 | 4.743:1 / 5.515:1 | [Pictures](08-native-capture/index.html?screen=automations) · Three automation rows show trigger and latest outcome, with a waiting run kept in words; schedules follow. |
| Settings | 3.570:1 / 3.433:1 | 4.888:1 / 5.515:1 | [Pictures](08-native-capture/index.html?screen=settings) · You, the named assistant, This Whombat, Screens and Advanced remain the shipped groups; Theme is direct. |
| Vault | 5.281:1 / 5.515:1 | 5.428:1 / 5.515:1 | [Pictures](08-native-capture/index.html?screen=vault) · Entries remain closed. Printer admin’s failing state is spoken, while its visible cue is a small status dot. |
| Files | GAP · content disabled | GAP · content disabled | [Pictures](08-native-capture/index.html?screen=files) · GAP: useFilesSpace returns false in fixtures. The route shows a heading and explanation, with no populated list. |
| Usage (Spend) | 5.281:1 / 5.515:1 | 5.428:1 / 5.515:1 | [Pictures](08-native-capture/index.html?screen=usage) · Spend has Today, 7 days and 30 days, with estimate details folded; it reads on open and pull, not live. |

## Glance-and-find review

Use a reviewer who has not seen the mockup. Run each task on all four platforms, light and dark, with the same fixtures. Record time, first choice, wrong turns and pass/fail. Reset between tasks; alternate platform order. These rules are prepared, not participant results.

### In five seconds, what needs you and what do you press?

Show a fresh participant the Chat list, Inbox, Overview and approval separately for five seconds, then hide each.

**Pass rule:** Pass each screen only if they name the actual waiting/broken item, distinguish assistant work from their decision, and name the correct visible action. No prompt from the reviewer; no irreversible action.

**Today:** Not run with an independent participant. Baseline concern: separate waiting/replies rows and competing pending-card labels.

### Find the Vault

Start at Chat with a fresh navigation state; ask them to open the Vault.

**Pass rule:** Within 30 seconds, no search-engine help, open the Vault and name an entry without revealing a secret. Time and wrong turns are recorded per platform.

**Today:** Web sidebar has Vault; phone navigation differs. Native Vault is captured through its deep link; the independent find-from-Chat task remains unrun.

### Find the evening brief setting

Start at Chat; ask them to find where to change the evening brief’s time, without changing it.

**Pass rule:** Within 45 seconds reach the evening brief card’s Change time control, or use the shipped assistant setting flow. A guess at Notifications or a morning brief does not pass.

**Today:** No evening brief card in this capture world. Shipped control is on the brief card (briefs.md BRF-01/05), not a Settings group. Task-state GAP; 06 should address the route without inventing a Settings page.

### Find the last run of an automation

Start at Automations; name one of its listed automations.

**Pass rule:** Within 30 seconds open its most recent run, state its outcome and time, and show the way back. Merely pointing at a run bar does not pass.

**Today:** List and component captured. An independent timing run and the automation-detail/run screenshots are still needed by 05.

### Tell whether the Overview numbers are current

Show Overview on arrival, then ask when the figures were last sampled.

**Pass rule:** Within 10 seconds identify a real sample/checked time and whether it is current, stale or unknown. Used today, uptime, 24 h average and a moving graph are not proof. A design passes only if it visibly provides that evidence or explicitly says freshness is unknown.

**Today:** FAIL in this snapshot: no sample time or explicit freshness-unknown label on the visible server figures. 05 owns this.

## GAP register

N-FILES-IOS and N-FILES-ANDROID: Files opens on both platforms, but `apps/mobile/src/data/useFiles.ts` deliberately disables Files-space content in fixtures. The scaffold is captured in both themes; a populated list cannot be scored without changing app code or leaving the fixture world. All ten marks remain GAP on each platform. See [native capture notes](08-native-capture/NOTES.md), [pictures](08-native-capture/index.html?screen=files) and [ten-point evidence](08-native-capture/evidence.md). Three supplied IDs belonged to web fixtures; their native missing-item states and the canonical native routes are recorded in 08. Both fixture-only native release builds succeeded.

The brief task, unseen loading/error variants, keyboard interaction and full native assistive-technology journeys remain additional verification gaps. Largest system text is now captured for Chat, thread, approval and Overview on both platforms; most text caps at 1.6×. Android’s universal 48dp target requirement is not met by the shared 44dp minimum. Future built-app columns stay empty.

## Platform differences to preserve

iOS: system tab bar and red system badges, SF chevron with previous-page title, edge back, native menus/sheets and confirmation alert. Android: token-coloured badges, 48dp arrow-back target and predictive back, app sheets/Material confirmation. iOS learning ring is the same native 10pt ring as Android; web is 8px. Approval cards open the native approval screen; web has direct answers and a details modal. These shipped platform differences are visible in the native evidence; menus, gestures and confirmation outcomes remain source-reviewed rather than full interaction tests.
