/**
 * Static audit of every `<Touchable>` / `<Pressable>` in the mobile app (excluding `Touchable.tsx`
 * itself, tests and stories): each one that declares an explicit pixel size must reach the 44dp minimum
 * (README "Accessibility") once its `hitSlop` is added, either literally sized (`minHeight: 44`) or padded
 * with `hitSlopFor()`/`hitSlop` (see `ui/touchTarget.ts`). The file list and per-file count are asserted
 * too, so a newly added interactive element that skips this check fails loudly instead of silently.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { meetsMinTouchTarget } from '../ui/touchTarget';

const ROOT = new URL('../../', import.meta.url);

/**
 * Every file with at least one `<Touchable>` / `<Pressable>` call site, and how many. Screens listed with 0 are
 * built only from the audited primitives (Button 44dp, Chip + 7dp slop, ListRow, a 44dp `<Switch>`); the count keeps
 * a hand-rolled control from slipping into them unchecked.
 */
const FILES: Record<string, number> = {
  'src/navigation/TabBar.tsx': 2,
  // The shell (phone-shell-final.md): Places and its sheet's Close and rows, Search above a tab, and Search's Clear, its
  // result rows and its small buttons — each at least 44pt on iPhone and 48dp on Android (`SHELL_TARGET`).
  'src/ui/places.tsx': 3,
  'src/ui/topRow.tsx': 1,
  'src/screens/SearchScreen.tsx': 3,
  'src/screens/PlanScreen.tsx': 2,
  'src/screens/RunActivity.tsx': 2,
  // The Settings tab (settings-tab-android.md AP-2622): built from the places' rows (ui/place.tsx) since the final
  // design (final-settings-vault-files-usage.md).
  'src/settings/SettingsScreen.tsx': 0,
  // The final places' row (Settings, Vault, Files): 64dp and more.
  'src/ui/place.tsx': 1,
  // The segmented control, moved out of the settings sheet (settings-tab-android.md AP-2621).
  'src/ui/Segmented.tsx': 1,
  // Tabs with an underline (underline-tabs-android.md AP-2636): a tab, 44dp tall.
  'src/ui/UnderlineTabs.tsx': 1,
  // + Save to Files and Download on a message's files (files-space.md AP-840): two 32dp rounds over a picture (padded
  // with hitSlopFor(32)), a row's 44dp Save and Download, Save in the viewer's 44dp header. + a page set's picture that
  // opens it (the card's width at 16:10, page-sets.md); its Open is the audited Button.
  'src/ui/attachments.tsx': 14,
  // A page set's viewer: Close, Back and Download, 44dp each (one site); Try again, Download and Open are Button.
  'src/ui/pageSetViewer.tsx': 1,
  // + the run line (AP-668): a 44dp row. + Cards that settle (AP-730…AP-735): a settled line, its chips row and “Open ›”, the
  // live run card's “Watch ›” and its open control, “Hide card”, an opened approval card's words, the thread reply row.
  // + a report's row (report-rows.md RR-02): its 44dp Details. − the `@` list's rows and the “To Banjo” chip's × (one
  // agent, AP-4982). + Stop on the thinking line and “Load earlier replies” under a thread's root, both 44dp (MX-09).
  // + the 44dp link under a message whose card moved down the thread (card-moves.md CM-07).
  // + the folded line of a card as it was and its “Newest” link, 44dp each (card-moves.md CM-10).
  'src/ui/chat.tsx': 25,
  // The 56dp round New chat button over Chat's and Feedback's lists (chat-inbox-phone.md AP-9380).
  'src/ui/newChatButton.tsx': 1,
  'src/ui/guide.tsx': 5,
  // + the 44dp button that hides and shows Chat's list with two pages (iphone-duo.md AP-6730). The back button is the
  // platform's: ✕ Close 44dp, iPhone's chevron (and its title) 44pt, Android's arrow in 48dp (phone-refresh-status.md).
  'src/ui/headers.tsx': 5,
  // + a row's long press beside its control (automation-recipes.md AP-981): the row's content, no size of its own.
  'src/ui/ListRow.tsx': 2,
  'src/ui/primitives.tsx': 2,
  'src/ui/richImages.tsx': 2,
  // The message's long-press Pressable (`accessible={false}`, no size of its own), in its memoised row since AP-901; the
  // “N replies” row is in ui/chat.tsx.
  'src/screens/ChatView.tsx': 0,
  'src/screens/MessageRow.tsx': 1,
  // Mobile chat (MX-01, MX-04): the “New messages ↓” pill (44dp), and a code block's Copy (32dp, padded) beside the
  // HTML preview's 44dp header buttons.
  'src/ui/jumpPill.tsx': 1,
  'src/ui/htmlPreview.tsx': 3,
  // A room thread's back is the header's own back button (ui/headers.tsx).
  'src/screens/ThreadScreen.tsx': 0,
  // A live card's quiet Stop and its ⋯ (CARD_TARGET).
  'src/ui/cardStop.tsx': 2,
  // What answers in Chat (chat-runtime-android.md AP-2715…AP-2728): the composer's 32dp icon (chat-runtime-icon.md
  // AP-2962), its 32dp “No AI yet” circle while no AI is signed in, and a reply's 20dp mark (all padded); the sheet's “Set it up” (20dp, padded), Claude · ChatGPT (44dp), a model's 48dp row and “N more…”
  // (44dp), an effort's 36dp pill (padded) and “Make this Neo’s default” (46dp).
  'src/ui/chatRuntime.tsx': 3,
  'src/screens/ChatRuntimeSheet.tsx': 6,
  'src/screens/VaultScreen.tsx': 0,
  'src/screens/VaultEntryScreen.tsx': 0,
  // The essentials (AP-500…AP-519): sheets, the message menu, reactions, the conversation menu and the new screens.
  'src/ui/sheet.tsx': 1,
  'src/ui/messageMenu.tsx': 4,
  // + “Saved to your Vault · Plex” under a message (vault-self-serve.md AP-4037): a 32dp line, padded.
  'src/ui/messageParts.tsx': 4,
  'src/screens/ConversationMenu.tsx': 3,
  'src/screens/ConversationScreen.tsx': 0,
  // Share to… (AP-715): rows, buttons and the upload chips' own audited sites only.
  'src/screens/ShareScreen.tsx': 0,
  'src/screens/PinsScreen.tsx': 0,
  'src/screens/EditMessageSheet.tsx': 0,
  // Do not disturb's “Turn off” (32dp, padded) and the quiet hours' day chips (36dp, padded).
  'src/settings/NotificationsSection.tsx': 2,
  // The assistant's page (one-agent.md AP-4965): its tabs are UnderlineTabs, its parts Button, ListRow, the segmented
  // control and the key rows' switch; Name and face's five face tiles (48dp min, AP-4966); What it may do's thing rows,
  // each its name and line as one 44dp-min button to its page. Advanced is ListRows and the same parts.
  'src/screens/AgentSettingsScreen.tsx': 0,
  'src/screens/agent/KeysPart.tsx': 0,
  'src/screens/agent/NotesSection.tsx': 0,
  'src/screens/agent/NameAndFacePart.tsx': 1,
  'src/screens/agent/MayPart.tsx': 1,
  'src/settings/AdvancedScreens.tsx': 0,
  'src/screens/PullRequestScreen.tsx': 0,
  'src/screens/PullRequestFileScreen.tsx': 0,
  'src/ui/keyRows.tsx': 0,
  // Files (files-space.md FS-07, AP-772…): a breadcrumb (44dp tall), an upload's 44dp ×, a file's row (44dp min) and
  // its 44dp ⋮; the action sheet's and the Move sheet's 52dp rows; the list and the parts are ListRow and tiles only.
  'src/screens/ConversationFilesScreen.tsx': 4,
  'src/screens/FileSheets.tsx': 2,
  'src/screens/FilesScreen.tsx': 0,
  'src/screens/FilesParts.tsx': 0,
  // Parity screens (mobile-parity.md MQ-01…MQ-06): an audit row (44dp min, opens its signed detail) and a picker row
  // (64dp checkbox); everything else is Button, ListRow, Chip, the segmented control and the key rows' switch.
  // What the agent runs on your Whombat, with Open and Stop (one-person-android.md AP-5760): Buttons only.
  'src/screens/ServicesSection.tsx': 0,
  // Usage's window chooser: 44pt on iPhone, 48dp on Android.
  'src/screens/SpendScreen.tsx': 1,
  'src/screens/AuditLogScreen.tsx': 1,
  'src/ui/facts.tsx': 0,
  // A canvas (MQ-05) and Deploys (MQ-07, work-removal-android.md AP-858): Button, ListRow and the sheet only.
  'src/screens/CanvasScreen.tsx': 0,
  'src/screens/DeploysPanel.tsx': 0,
  'src/screens/DeploysScreen.tsx': 0,
  // Automations made by talking to the agent (automation-chat-mobile.md): the 56dp “Tell Dusty…” field, and More detail
  // under a list that didn't load (44pt iOS, 48dp Android).
  'src/screens/AutomationsScreen.tsx': 2,
  // A row on the Automations list (automation-page.md AP-6330), 72dp and more; the 44dp waiting line that opens the
  // run, or a plan's conversation.
  'src/screens/AutomationRow.tsx': 2,
  // An automation's page (automation-page.md AP-6331): a run's 44dp row, the 44dp “What Dusty is asked” fold and the
  // 44dp Delete; Try it and Talk about it are the audited Button.
  'src/screens/AutomationScreen.tsx': 3,
  // A plan's card in a chat (automation-chat-mobile.md): the 44dp “What Dusty is asked” fold; its buttons are Button and
  // its “Hide card” is chat.tsx's.
  'src/ui/automationPlanCard.tsx': 1,
  // A feature request's card in a chat: the 44dp “What the customer reads” fold; its
  // buttons are Button, its fields FormField and its “Hide card” is chat.tsx's.
  'src/ui/featureRequestCard.tsx': 1,
  // A run in plain words (automation-recipes.md AP-1010, AP-1014): an assessed step that opens its request (the row's
  // content, no size of its own), its 44dp “Technical details” and the 44dp “4 more steps skipped” row.
  'src/screens/AutomationRunScreen.tsx': 3,
  // A run's tracker report (report-trackers.md TA-14, TA-15): the screenshot's 180dp thumbnail and its full-screen
  // viewer's 44dp Close; the sheets' status radio rows (44dp min, one site for both sheets). Reply and Set status are
  // the audited Button.
  'src/screens/TrackerItem.tsx': 2,
  'src/screens/TrackerSheets.tsx': 1,
  // How it's doing on This Whombat (box-status-android.md AP-1152, AP-1153): the range is the segmented control, the
  // chart switcher the chips, and a chart is a View that takes the finger (no Touchable).
  // + “Show charts” / “Hide charts” under the tiles (this-whombat-sections-android.md AP-1245): a 44dp link-style
  // button.
  'src/managed/HostStatus.tsx': 1,
  'src/managed/HostCharts.tsx': 0,
  // This Whombat in parts (this-whombat-sections-android.md AP-1251): an AT A GLANCE row (`LinkRow`, 56dp min),
  // a diagnostics part's checkbox row (44dp min) on About, the invitation's “as owner” checkbox (44dp min) on Devices &
  // owners; NEEDS YOU's buttons, Backups and the rest are Button and Row.
  'src/managed/ui.tsx': 1,
  'src/managed/WhombatScreen.tsx': 0,
  // The desk screen (desk-display-android.md AP-3057): SCREEN, its sheets and the unlock request are Button (44dp), the
  // segmented control, 44dp switches and the clock fields (44dp), as Settings → Notifications' quiet hours. + a voice
  // under Talk (AP-3425): its 56dp radio row beside its 44dp Listen button.
  'src/managed/DeskSection.tsx': 1,
  'src/managed/DeskUnlockCard.tsx': 0,
  // Settings → Screen (desk-display-android.md AP-5865): a server's 44dp Move up and Move down (one site); the rest is
  // the segmented control, 44dp switches, Button and the tabs. The preview is a drawing, nothing in it to press.
  'src/settings/DeskScreenPage.tsx': 0,
  'src/settings/DeskShowsPart.tsx': 1,
  'src/settings/DeskPreviewScreen.tsx': 0,
  // Settings → Screens (desk-display-android.md AP-6000…AP-6022): a screen's 72dp row (its Edit layout a Button); a
  // screen's page is Button, Field, the segmented control and LinkRow; the editor's the page chips and + Page in the
  // chips' shape (their 7dp slop), Button and Field; the grid's tiles are 36dp and more with a 4dp slop on each side
  // (sized from the screen's grid, checked by `tiles.test.ts`); a widget's
  // sheet has the 44dp arrows and size steppers (one site), a server's or a part's 52dp radio row and the 44dp Remove;
  // Add a widget's 56dp fold headings and item rows and its 48dp *Show its widgets* (AP-6032…).
  'src/settings/screens/ScreensList.tsx': 1,
  'src/settings/screens/AddScreenSheet.tsx': 0,
  'src/settings/screens/ScreenPage.tsx': 0,
  'src/settings/screens/LayoutEditor.tsx': 1,
  'src/settings/screens/TileGrid.tsx': 1,
  'src/settings/screens/WidgetSheet.tsx': 3,
  'src/settings/screens/AddWidgetSheet.tsx': 3,
  // Voice typing (docs/decisions/dictation.md): the composers' mic and the recording bar's Cancel and Done, 32dp rounds
  // padded to 44dp; VOICE TYPING is 44dp switches, segmented controls, Button and the Dutch voice licence's 44dp link.
  'src/voice/VoiceBar.tsx': 3,
  'src/managed/VoiceSection.tsx': 1,
  'src/ui/ClockField.tsx': 0,
  // The machine (hardware-support-android.md AP-3258): NETWORK and HARDWARE are Button (44dp) and Row; the Wi-Fi sheet's
  // network rows and Other network… share one 52dp row, its Show/Hide and buttons are Button (48dp and 44dp).
  'src/managed/NetworkSection.tsx': 0,
  'src/managed/WifiSheet.tsx': 1,
  'src/managed/HardwareSection.tsx': 0,
  'src/managed/MachineParts.tsx': 0,
  // Bluetooth (bluetooth-android.md AP-3753, AP-3758): a paired device's 44dp ⋯ and its action sheet's 52dp rows (one
  // site); the Add a device sheet's found rows (52dp); the rest is Button and Row.
  'src/managed/BluetoothSection.tsx': 2,
  'src/managed/BluetoothSheet.tsx': 1,
  'src/managed/WhombatBackupsScreen.tsx': 0,
  'src/managed/WhombatAboutScreen.tsx': 1,
  // REMOTE HELP on About (app remote-help.md AP-4479): a step's 44dp Show; the rest is Button, the radio cards, the
  // segmented control and the sheet.
  'src/managed/RemoteHelpSection.tsx': 1,
  // Devices: rows, Button and the passkey policy's switch only (one-person-android.md AP-5740).
  'src/managed/DevicesScreen.tsx': 0,
  // Connections (connections-redesign-android.md AP-1170…AP-1175): rows and the Add a connection Button; Add a
  // connection's search clear (34dp, padded) and the footer's two links (13.5px text, padded to 45dp; one site).
  'src/screens/ConnectionsScreen.tsx': 0,
  'src/screens/AddConnectionScreen.tsx': 2,
  // Backup file (backup-file-android.md AP-1212, AP-1217): a category's tick row in each panel (56dp min, the whole row is
  // the checkbox); everything else is Button, FormField and the segmented control.
  'src/managed/BackupFileScreen.tsx': 2,
  // One Whombat (one-whombat-mobile.md AP-1378): a card row (52dp min) and the sheet's big button (52dp); the device
  // skill card's tier segments (38dp, padded); Chats' 44dp New chat. The other screens and sheets are those rows,
  // buttons and the segmented control. Connections' avatar is gone: Settings is a tab (settings-tab-android.md AP-2628).
  'src/ui/assistant.tsx': 2,
  // An approval's quiet words side by side under its answers: 44dp text buttons.
  'src/ui/oneSheet.tsx': 1,
  'src/ui/deviceSkillCard.tsx': 1,
  // The headline's sentence that opens its Inbox row, 44dp (phone-refresh-status.md).
  'src/screens/HomeScreen.tsx': 1,
  'src/screens/NeedsYouSheet.tsx': 0,
  'src/screens/NewChatSheet.tsx': 0,
  'src/screens/ChatScreen.tsx': 0,
  // Chat (chat-channel.md AP-2461): the 44dp Feedback beside its title; Settled's 44dp “Show more” and its rows (44dp
  // min, chat-settle.md AP-6252); Chat's 44dp ⋯ on a narrow page. A room's back is the header's back button.
  'src/screens/ChatRoomScreen.tsx': 2,
  // Chat as an inbox (chat-inbox-phone.md): the filter chips (30dp, padded to 44), the 44dp “Settled ›” beside them and a
  // thread's row (64dp min).
  'src/screens/ChatInbox.tsx': 3,
  'src/screens/SettledScreen.tsx': 2,
  // Settling threads (chat-settle.md AP-6154, AP-6157): the thread header's 34dp Settle (padded) and a settled thread's
  // 32dp Open again (padded). Profile's CHAT has none.
  'src/ui/threadSettle.tsx': 3,
  // A swipe row's panels (ios-native.md AP-6274): 96dp wide and the row's height (44dp and more), a menu's panel and
  // another's, and the open row's cover that closes it.
  'src/ui/swipeRow.tsx': 3,
  // A menu as a sheet (ios-native.md AP-6271): 52dp rows.
  'src/ui/nativeMenu.tsx': 1,
  // “Settle threads by themselves”, a 56dp row that opens its choices (chat-inbox-phone.md).
  'src/settings/ChatSettleSection.tsx': 1,
  'src/screens/ThingScreen.tsx': 0,
  // The head's 44dp ⋯ (Rename), a sheet's button where iOS's own menu isn't.
  'src/screens/ServerScreen.tsx': 1,
  // A name edited where it is shown (a held row's Rename, a server page's): the 44dp Cancel under the box.
  'src/ui/inlineRename.tsx': 1,
  // A guest's screen (proxmox-mobile.md AP-1485…AP-1500): Buttons, the tabs (UnderlineTabs, AP-2633), card rows and
  // sheets; a settings row's 44dp Change or Grow, and the 44dp line that opens the web.
  'src/screens/GuestScreen.tsx': 0,
  'src/screens/guest/parts.tsx': 1,
  'src/screens/guest/GuestSettings.tsx': 1,
  'src/screens/guest/GuestSummary.tsx': 0,
  'src/screens/guest/GuestSheets.tsx': 0,
  'src/screens/guest/GuestSnapshots.tsx': 0,
  'src/screens/guest/GuestBackups.tsx': 0,
  'src/screens/guest/GuestTasks.tsx': 0,
  'src/screens/ServerBackups.tsx': 0,
  // Incus, Unraid and the self guest (incus-unraid-mobile.md AP-1617…): Buttons, card rows, settings rows' 44dp Change,
  // sheets and switches; the 44dp line that opens the web, and a container's 52dp web page row.
  'src/screens/guest/IncusSettings.tsx': 1,
  'src/screens/guest/IncusSheets.tsx': 0,
  'src/screens/guest/IncusBackups.tsx': 0,
  'src/screens/guest/IncusSummary.tsx': 0,
  'src/screens/guest/ContainerCard.tsx': 1,
  'src/screens/server/IncusServer.tsx': 0,
  'src/screens/server/UnraidParts.tsx': 0,
  'src/screens/server/UnraidSheets.tsx': 0,
  // QEMU/KVM (IU-13, AP-1642…): built from the same rows, sheets and switches.
  'src/screens/guest/LibvirtSettings.tsx': 0,
  'src/screens/guest/LibvirtSheets.tsx': 0,
  'src/screens/server/LibvirtServer.tsx': 0,
  // Add a server (server-signin-mobile.md AP-1712): the level's three segments (48dp), a 44dp text link (“Or use a key from
  // the Vault”, More detail), SI-09's 44dp checkbox row and a key's 52dp radio row; the rest is Button, FormField and the
  // segmented control.
  'src/screens/AddServerScreen.tsx': 4,
  // Less is more (less-is-more.md AP-1811): the “More” fold under a page's one sentence, a 44dp link-style button.
  'src/ui/fold.tsx': 1,
  // A connection's page (connection-pages-mobile.md AP-1950…): “Runs on” (44dp), Settings beside the tabs (44dp; the
  // tabs are UnderlineTabs, AP-2634), a card's header link (28dp, padded), a table row that opens a page (52dp) and a
  // “Show more here” chip (36dp, padded); the rest is Button, BigButton, OneRow and the sheets.
  // + a service's head (service-slots-mobile.md AP-7130…): its 44dp ⋯ in the back bar and the two 46dp buttons (one
  // site). + the head of every page (phone-refresh-status.md): “Runs on”, the 44dp address that copies and More detail.
  // + the 44dp ⋯ of a page whose only item is Keep quiet… (monitoring.md MON-04).
  'src/screens/ThingPageScreen.tsx': 6,
  'src/screens/thing/ThingTabs.tsx': 1,
  'src/screens/thing/parts.tsx': 1,
  // + the Summary (dashboards-mobile.md AP-2120…): Worth a look's 44dp “Show N more”, a table row's own 52dp area beside
  // its 32dp button (padded), a bar line that opens a page (52dp); the range control's 38dp ranges (padded); a figure
  // that opens its charts or its tab (44dp min) and the opened figure's 30dp close button (padded; AP-2558).
  // + a service's lines (service-dashboards.md AP-4644, AP-4645): a notice with a button and a list line that opens the
  // service's page, each 52dp min, their buttons beside or under them (ThingButton.tsx).
  // + quiet notices (quiet-notices-mobile.md AP-4861, AP-4862): a line's 44dp ⋯ and a quiet line's 44dp Undo; on
  // iPhone the line held in iOS's menu is its own 52dp site (ios-native.md AP-6271).
  // + a server's figures' 44dp See reading history (overview-server-connection-final.md).
  // + a held line's 44dp End now (monitoring.md MON-04).
  'src/screens/thing/Panels.tsx': 14,
  // Monitoring (monitoring.md MON-04, MON-07): the hold's 44dp End now and the 36dp cause link (padded); What happened
  // and the sheets are rows, OneCard, Chip, the clock field and BigButton.
  'src/screens/thing/Monitoring.tsx': 2,
  // Quiet notices (quiet-notices-mobile.md AP-4861…AP-4867): the ⋯ menu's 52dp rows (one site); What Whombat watches'
  // 44dp Undo on an exception and its 44dp “Show N more”; the toast's 44dp Undo and, with VoiceOver, its 44dp ✕.
  'src/screens/thing/QuietMenu.tsx': 1,
  // + a limit's 44dp Change (monitoring.md MON-15).
  'src/screens/thing/WhatWhombatWatches.tsx': 3,
  'src/ui/Toast.tsx': 2,
  // A service's page (service-dashboards.md AP-4630…): a gallery item's link (its picture and words, 100dp and more), the
  // small 32dp button (padded) and the head's 44dp button, a switch tile (44dp min, the switch inside it only shows) and
  // a stepper's 36dp − and + (padded); pictures are Views.
  'src/screens/thing/Gallery.tsx': 1,
  'src/screens/thing/ThingButton.tsx': 3,
  // A service's Summary in slots (service-slots-mobile.md AP-7130…): the strip's 44dp “Show N more”, a line's 30dp link
  // button (padded), its words (44dp, held for the menu), its 44dp ⋯ and Undo; a Live card and a
  // shelf picture (100dp and more); a tile's 30dp Scan is ThingButton's icon button (padded).
  'src/screens/thing/Slots.tsx': 7,
  'src/screens/thing/Controls.tsx': 2,
  'src/screens/thing/Picture.tsx': 0,
  'src/screens/thing/Changes.tsx': 0,
  'src/screens/thing/ChartCard.tsx': 0,
  'src/screens/thing/RangeControl.tsx': 1,
  // Needs you (needs-you-list.md NYL-05): a row (52dp min), the heads-ups' fold row, the foot's link (44dp) and a row's
  // More beside its way forward (44pt / 48dp, approval-card.md).
  'src/screens/NeedsYouScreen.tsx': 4,
  // Overview (overview-one-page.md): a server's card and a connection's tile (no size of their own, tall with content),
  // a section heading's 44dp “Add a server” or “Add a connection”, a change's Undo or Review (44dp); Everything I did
  // and the pinned panels are card rows, Buttons and the chart's own element.
  'src/screens/home/ServersCard.tsx': 1,
  // Try again is a Button, More detail the fold's own; the jump chips under the title (34dp, padded).
  'src/screens/home/OverviewParts.tsx': 1,
  // The arranged Overview (overview-arranged.md): a tile (tall with content) and the dashed Add
  // to Overview (150dp); Arrange beside the title (40dp, padded) and a gear (34dp, padded); the summary card's 44dp
  // “2 other things need you” (Look into it is a Button); Today's 44dp All activity, a moment (44dp) and Show all; a
  // gear's sheet: Close (40dp, padded), a choice (44dp), a size (44dp) and Remove from Overview (44dp).
  'src/screens/home/ServicesCard.tsx': 2,
  'src/screens/home/ArrangedParts.tsx': 2,
  'src/screens/home/SummaryCard.tsx': 1,
  'src/screens/home/TodayCard.tsx': 3,
  'src/screens/home/ArrangeSheets.tsx': 4,
  'src/screens/home/Section.tsx': 1,
  'src/screens/home/DoneParts.tsx': 1,
  'src/screens/home/PanelsCards.tsx': 0,
  'src/screens/DoneScreen.tsx': 0,
  // Connecting from the phone (phone-connect.md PC-11, AP-2915): a radio card's row (52dp), a 44dp text link, a value's
  // 44dp Copy, More options' 44dp toggle, a service's 48dp checkbox row; the rest is Button, FormField, Segmented.
  'src/ui/radioCards.tsx': 1,
  'src/screens/connect/parts.tsx': 3,
  'src/screens/ConnectScreen.tsx': 0,
  'src/screens/ConnectAccountScreen.tsx': 1,
  'src/screens/connect/AppSetup.tsx': 0,
  'src/screens/connect/Imap.tsx': 0,
  'src/screens/connect/FoundOnNetwork.tsx': 0,
  'src/screens/connect/ConnectionChanges.tsx': 0,
};

interface Site {
  tag: string;
  props: string;
}

/** Every file with a `<Switch>` (RN's own, sized by the platform), and how many. */
const SWITCH_FILES: Record<string, number> = {
  // Settings → Screen (AP-5865): Show Whombat on this screen, Quiet hours, Talk, the camera; Welcome back and Done today.
  'src/managed/DeskSection.tsx': 4,
  'src/settings/DeskShowsPart.tsx': 1,
  // An automation's On/Off on its page (automation-page.md AP-6331).
  'src/screens/AutomationScreen.tsx': 1,
  // Quiet hours, and “Show message text in notifications” (push-previews.md AP-809).
  'src/settings/NotificationsSection.tsx': 2,
  // Profile → CHAT: Settle quiet threads and Settle when its code is merged (chat-settle.md AP-6156), one site.
  'src/settings/ChatSettleSection.tsx': 1,
  'src/screens/VaultEntryScreen.tsx': 1,
  // A key or a channel as a switch (AP-713).
  'src/ui/keyRows.tsx': 1,
  // VOICE TYPING's *Voice typing* and *Dutch voice* switches.
  'src/managed/VoiceSection.tsx': 2,
  // A guest's sheets: start with the server, protection, memory in a snapshot, start after a restore (AP-1494).
  'src/screens/guest/parts.tsx': 1,
  // Fast replies in the Chat's sheet (chat-runtime-android.md AP-2721) and on Runs on (AP-2730).
  'src/screens/ChatRuntimeSheet.tsx': 1,
  'src/screens/RunsOnSection.tsx': 1,
  // A control's switch (service-dashboards.md AP-4641): drawn in its tile, which takes the presses.
  'src/screens/thing/Controls.tsx': 1,
  // A check's switch in What Whombat watches (quiet-notices-mobile.md AP-4865).
  'src/screens/thing/WhatWhombatWatches.tsx': 1,
};

/** Finds every `<Touchable ...>` / `<Pressable ...>` (or `tags`) opening tag and its prop text (brace-depth aware). */
function findSites(source: string, tags = /<(Touchable|Pressable)\b/g): Site[] {
  const sites: Site[] = [];
  const re = new RegExp(tags.source, 'g');
  let m: RegExpExecArray | null = re.exec(source);
  while (m) {
    const tag = m[1] as string;
    let i = re.lastIndex;
    let depth = 0;
    const start = i;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
      i++;
    }
    sites.push({ tag, props: source.slice(start, i) });
    m = re.exec(source);
  }
  return sites;
}

/** A `n` / `{n}` numeric prop value, e.g. `width={34}` or (inside a style object) `width: 34`. */
function numberProp(props: string, name: string): number | undefined {
  const m = new RegExp(`\\b${name}(?::|=\\{)\\s*(\\d+(?:\\.\\d+)?)`).exec(props);
  return m ? Number(m[1]) : undefined;
}

/** `hitSlop={6}`, `hitSlop={{top: 6, ...}}` or `hitSlop={hitSlopFor(32)}` (resolved against the real helper). */
function hitSlop(props: string): { top: number; bottom: number; left: number; right: number } {
  const zero = { top: 0, bottom: 0, left: 0, right: 0 };
  const fn = /hitSlop=\{hitSlopFor\((\d+(?:\.\d+)?)\)\}/.exec(props);
  if (fn) {
    // biome-ignore lint/style/noNonNullAssertion: matched by the regex above
    const size = Number(fn[1]!);
    const pad = Math.max(0, Math.ceil((44 - size) / 2));
    return { top: pad, bottom: pad, left: pad, right: pad };
  }
  const num = /hitSlop=\{(\d+(?:\.\d+)?)\}/.exec(props);
  if (num) {
    // biome-ignore lint/style/noNonNullAssertion: matched by the regex above
    const n = Number(num[1]!);
    return { top: n, bottom: n, left: n, right: n };
  }
  const obj = /hitSlop=\{\{([^}]*)\}\}/.exec(props);
  if (obj) {
    return {
      top: numberProp(obj[1] ?? '', 'top') ?? 0,
      bottom: numberProp(obj[1] ?? '', 'bottom') ?? 0,
      left: numberProp(obj[1] ?? '', 'left') ?? 0,
      right: numberProp(obj[1] ?? '', 'right') ?? 0,
    };
  }
  return zero;
}

describe('mobile touch targets', () => {
  it('only has the accounted-for Touchable/Pressable call sites', () => {
    for (const [path, expected] of Object.entries(FILES)) {
      const source = readFileSync(new URL(path, ROOT), 'utf8');
      expect(findSites(source), path).toHaveLength(expected);
    }
  });

  it('reaches 44dp (size + hitSlop) wherever a call site declares an explicit pixel size', () => {
    const failures: string[] = [];
    for (const path of Object.keys(FILES)) {
      const source = readFileSync(new URL(path, ROOT), 'utf8');
      for (const site of findSites(source)) {
        const height = numberProp(site.props, 'height') ?? numberProp(site.props, 'minHeight');
        const width = numberProp(site.props, 'width') ?? numberProp(site.props, 'minWidth');
        // Flex-driven or content-driven axes (no explicit px size) aren't checkable statically; the
        // known sites without an explicit height/width were reviewed by hand (see docs/decisions/accessibility.md).
        if (height === undefined && width === undefined) continue;
        const slop = hitSlop(site.props);
        const ok = meetsMinTouchTarget({ width: width ?? 44, height: height ?? 44 }, slop);
        if (!ok)
          failures.push(
            `${path}: <${site.tag}> ${width ?? '?'}x${height ?? '?'} + hitSlop ${JSON.stringify(slop)}`,
          );
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps every <Switch> at least 44dp tall (Android draws it smaller)', () => {
    const failures: string[] = [];
    for (const [path, expected] of Object.entries(SWITCH_FILES)) {
      const source = readFileSync(new URL(path, ROOT), 'utf8');
      const sites = findSites(source, /<(Switch)\b/g);
      expect(sites, path).toHaveLength(expected);
      for (const site of sites)
        if ((numberProp(site.props, 'minHeight') ?? 0) < 44) failures.push(`${path}: <Switch> under 44dp`);
    }
    expect(failures).toEqual([]);
  });

  it('pads with hitSlopFor(n) only a control that is n dp on some axis (no assumed sizes)', () => {
    // `hitSlopFor(28)` on a text button with no size of its own claimed 28dp while the button was ~27dp
    // tall inside a 36dp chip that clips touches (Android verification): the padding must match a real size.
    // Sized by their content, reviewed by hand: the 36dp avatar (chat header title) and the
    // receipt row (20dp badge + two lines + 10dp padding ≥ 40dp).
    const sizedByContent: Record<string, number[]> = {
      'src/ui/chat.tsx': [40],
      'src/ui/headers.tsx': [36],
    };
    const failures: string[] = [];
    for (const path of Object.keys(FILES)) {
      const source = readFileSync(new URL(path, ROOT), 'utf8');
      const reviewed = [...(sizedByContent[path] ?? [])];
      for (const site of findSites(source)) {
        const fn = /hitSlop=\{hitSlopFor\((\d+(?:\.\d+)?)\)\}/.exec(site.props);
        if (!fn) continue;
        const claimed = Number(fn[1]);
        const sizes = ['height', 'minHeight', 'width', 'minWidth'].map((n) => numberProp(site.props, n));
        if (sizes.includes(claimed)) continue;
        const i = reviewed.indexOf(claimed);
        if (i >= 0) reviewed.splice(i, 1);
        else failures.push(`${path}: <${site.tag}> hitSlopFor(${claimed}) without that size`);
      }
    }
    expect(failures).toEqual([]);
  });
});
